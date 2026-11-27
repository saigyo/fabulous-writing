import multiprocessing
import threading

from app.core.models import Language
from app.services.terminology import (
    Actor,
    Concept,
    ProcessStatus,
    SectionInput,
    TermInput,
    TerminologyConflictError,
    TerminologyRuleError,
    TerminologyStore,
    UsageStatus,
)

ME = Actor(user_id=1, is_admin=False)


def _forbidden_only() -> SectionInput:
    return SectionInput(
        language=Language.EN,
        terms=[TermInput(text="forbidden", usage_status=UsageStatus.FORBIDDEN)],
    )


def _setup(db) -> tuple[TerminologyStore, Concept]:
    store = TerminologyStore(db)
    domain = store.create_domain("Medicine", owner_id=ME.user_id)
    concept = store.create_concept(domain.id, [_forbidden_only()], actor=ME)
    assert concept is not None
    return store, concept


def _preferred_active(concept: Concept) -> list[str]:
    return [
        t.text
        for t in concept.sections[0].terms
        if t.usage_status == UsageStatus.PREFERRED and t.process_status == ProcessStatus.ACTIVE
    ]


def _add_preferred_worker(dsn: str, concept_id: int, section: dict, index: int, barrier, queue) -> None:
    from app.services.db.postgres import PostgresDatabase

    database = PostgresDatabase(dsn)
    try:
        store = TerminologyStore(database, manage_schema=False)
        given = SectionInput.model_validate(section)
        given.terms.append(TermInput(text=f"preferred {index}", usage_status=UsageStatus.PREFERRED))
        barrier.wait()
        try:
            store.save_section(concept_id, given, actor=ME)
        except TerminologyConflictError:
            queue.put("conflict")
        else:
            queue.put("saved")
    finally:
        database.close()


def test_of_simultaneous_saves_with_one_number_exactly_one_succeeds(pg_database):
    # Processes, not threads: see TestPostgresReservationConcurrency in test_usage.py.
    store, concept = _setup(pg_database)
    section = SectionInput.from_section(concept.sections[0]).model_dump()
    dsn = pg_database._pool.conninfo
    ctx = multiprocessing.get_context("spawn")
    barrier = ctx.Barrier(8)
    queue = ctx.Queue()
    processes = [
        ctx.Process(
            target=_add_preferred_worker, args=(dsn, concept.id, section, i, barrier, queue)
        )
        for i in range(8)
    ]
    for p in processes:
        p.start()
    results = None
    try:
        results = [queue.get(timeout=30) for _ in processes]
    finally:
        if results is None:
            for p in processes:
                if p.is_alive():
                    p.terminate()
            for p in processes:
                p.join(timeout=10)
        else:
            for p in processes:
                p.join()
    assert all(p.exitcode == 0 for p in processes), [p.exitcode for p in processes]
    assert sorted(results) == ["conflict"] * 7 + ["saved"], results
    after = store.get_concept(concept.id, owner_id=ME.user_id)
    assert after is not None
    assert len(_preferred_active(after)) == 1
    assert after.sections[0].revision == 2


def test_a_save_compares_the_number_only_after_locking_the_concept(pg_database):
    store, concept = _setup(pg_database)
    en = concept.sections[0]
    section = SectionInput.from_section(en)
    section.terms.append(TermInput(text="preferred", usage_status=UsageStatus.PREFERRED))
    outcome: dict = {}

    def save() -> None:
        try:
            outcome["result"] = store.save_section(concept.id, section, actor=ME)
        except Exception as exc:
            outcome["error"] = exc

    worker = threading.Thread(target=save, daemon=True)
    conn = pg_database.raw_connect()
    try:
        conn.execute("UPDATE concepts SET uid = uid WHERE id = ?", (concept.id,))
        conn.execute(
            "UPDATE concept_languages SET revision = revision + 1 WHERE id = ?", (en.id,)
        )
        worker.start()
        worker.join(timeout=1.0)
        assert worker.is_alive()
        conn.commit()
    finally:
        conn.close()
        if worker.is_alive():
            worker.join(timeout=10)
    assert not worker.is_alive()
    assert isinstance(outcome.get("error"), TerminologyConflictError), outcome
    after = store.get_concept(concept.id, owner_id=ME.user_id)
    assert after is not None
    assert _preferred_active(after) == []


def test_creating_a_concept_waits_for_a_domain_being_deleted(pg_database):
    store = TerminologyStore(pg_database)
    domain = store.create_domain("Medicine", owner_id=ME.user_id)
    outcome: dict = {}

    def create() -> None:
        try:
            outcome["result"] = store.create_concept(domain.id, [_forbidden_only()], actor=ME)
        except Exception as exc:
            outcome["error"] = exc

    worker = threading.Thread(target=create, daemon=True)
    conn = pg_database.raw_connect()
    try:
        conn.execute("UPDATE domains SET name = name WHERE id = ?", (domain.id,))
        worker.start()
        worker.join(timeout=1.0)
        assert worker.is_alive()
        conn.execute("DELETE FROM domains WHERE id = ?", (domain.id,))
        conn.commit()
    finally:
        conn.close()
        if worker.is_alive():
            worker.join(timeout=10)
    assert not worker.is_alive()
    assert outcome == {"result": None}
    with pg_database.connect() as check:
        assert check.execute("SELECT COUNT(*) AS n FROM concepts").fetchone()["n"] == 0


def test_moving_a_concept_waits_for_its_new_domain_being_deleted(pg_database):
    store, concept = _setup(pg_database)
    (a,) = concept.domain_ids
    b = store.create_domain("Law", owner_id=ME.user_id).id
    outcome: dict = {}

    def move() -> None:
        try:
            outcome["result"] = store.save_concept(
                concept.id, domain_ids=[b], revision=concept.revision, actor=ME
            )
        except Exception as exc:
            outcome["error"] = exc

    worker = threading.Thread(target=move, daemon=True)
    conn = pg_database.raw_connect()
    try:
        conn.execute("UPDATE domains SET name = name WHERE id = ?", (b,))
        worker.start()
        worker.join(timeout=1.0)
        assert worker.is_alive()
        conn.execute("DELETE FROM domains WHERE id = ?", (b,))
        conn.commit()
    finally:
        conn.close()
        if worker.is_alive():
            worker.join(timeout=10)
    assert not worker.is_alive()
    error = outcome.get("error")
    assert isinstance(error, TerminologyRuleError) and error.rule == "unknown_domain", outcome
    after = store.get_concept(concept.id, owner_id=ME.user_id)
    assert after is not None
    assert after.domain_ids == [a]


def test_deleting_a_domain_waits_for_a_concept_being_created_in_it(pg_database):
    store = TerminologyStore(pg_database)
    domain = store.create_domain("Medicine", owner_id=ME.user_id)
    outcome: dict = {}

    def delete() -> None:
        try:
            outcome["result"] = store.delete_domain(domain.id, actor=ME)
        except Exception as exc:
            outcome["error"] = exc

    worker = threading.Thread(target=delete, daemon=True)
    conn = pg_database.raw_connect()
    try:
        conn.execute("UPDATE domains SET name = name WHERE id = ?", (domain.id,))
        concept_id = conn.execute(
            "INSERT INTO concepts (uid, owner_id) VALUES (?, ?) RETURNING id",
            ("concurrent", ME.user_id),
        ).fetchone()["id"]
        conn.execute(
            "INSERT INTO concept_domains (concept_id, domain_id) VALUES (?, ?)",
            (concept_id, domain.id),
        )
        worker.start()
        worker.join(timeout=1.0)
        assert worker.is_alive()
        conn.commit()
    finally:
        conn.close()
        if worker.is_alive():
            worker.join(timeout=10)
    assert not worker.is_alive()
    assert outcome == {"result": True}
    with pg_database.connect() as check:
        unlinked = check.execute(
            "SELECT COUNT(*) AS n FROM concepts"
            " WHERE id NOT IN (SELECT concept_id FROM concept_domains)"
        ).fetchone()["n"]
    assert unlinked == 0


def _merge_worker(dsn: str, source_id: int, target_id: int, basis: dict, barrier, queue) -> None:
    from app.services.db.postgres import PostgresDatabase
    from app.services.terminology.model import TransferBasis, TransferOutdatedError

    database = PostgresDatabase(dsn)
    try:
        store = TerminologyStore(database, manage_schema=False)
        barrier.wait()
        try:
            outcome = store.merge_concept(
                source_id, target_id, basis=TransferBasis.model_validate(basis), actor=ME
            )
        except TransferOutdatedError:
            queue.put("outdated")
        except Exception as exc:  # noqa: BLE001
            queue.put(f"error: {type(exc).__name__}: {exc}")
        else:
            queue.put("merged" if outcome is not None else "none")
    finally:
        database.close()


def test_two_merges_of_the_same_pair_in_opposite_directions(pg_database):
    store = TerminologyStore(pg_database)
    domain = store.create_domain("Medicine", owner_id=ME.user_id)

    def one(text: str) -> Concept:
        created = store.create_concept(
            domain.id,
            [SectionInput(language=Language.EN, terms=[TermInput(text=text, usage_status=UsageStatus.PREFERRED)])],
            actor=ME,
        )
        assert created is not None
        return created

    a, b = one("alpha"), one("beta")
    basis_ab = store.merge_concept(a.id, b.id, basis=None, preview=True, actor=ME).basis
    basis_ba = store.merge_concept(b.id, a.id, basis=None, preview=True, actor=ME).basis
    dsn = pg_database._pool.conninfo
    ctx = multiprocessing.get_context("spawn")
    barrier = ctx.Barrier(2)
    queue = ctx.Queue()
    processes = [
        ctx.Process(
            target=_merge_worker,
            args=(dsn, source, target, basis.model_dump(mode="json"), barrier, queue),
        )
        for source, target, basis in ((a.id, b.id, basis_ab), (b.id, a.id, basis_ba))
    ]
    for p in processes:
        p.start()
    results = None
    try:
        results = [queue.get(timeout=30) for _ in processes]
    finally:
        if results is None:
            for p in processes:
                if p.is_alive():
                    p.terminate()
        for p in processes:
            p.join(timeout=10)
    assert not any(p.is_alive() for p in processes)
    assert all(p.exitcode == 0 for p in processes), [p.exitcode for p in processes]
    assert results.count("merged") == 1, results
    assert next(r for r in results if r != "merged") in ("outdated", "none"), results
    with pg_database.connect() as check:
        remaining = check.execute("SELECT id FROM concepts").fetchall()
        texts = sorted(r["text"] for r in check.execute("SELECT text FROM concept_terms").fetchall())
    assert len(remaining) == 1
    assert texts == ["alpha", "beta"]
