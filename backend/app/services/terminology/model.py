from dataclasses import dataclass
from enum import StrEnum

from pydantic import BaseModel, Field, computed_field, field_validator

from app.core.models import Language


class UsageStatus(StrEnum):
    PREFERRED = "preferred"
    ADMITTED = "admitted"
    DEPRECATED = "deprecated"
    FORBIDDEN = "forbidden"


class ProcessStatus(StrEnum):
    CANDIDATE = "candidate"
    ACTIVE = "active"


PROCESS_STATUS_ENFORCED: dict[ProcessStatus, bool] = {
    ProcessStatus.CANDIDATE: False,
    ProcessStatus.ACTIVE: True,
}


def is_enforced(status: ProcessStatus) -> bool:
    return PROCESS_STATUS_ENFORCED[status]


class PartOfSpeech(StrEnum):
    NOUN = "noun"
    VERB = "verb"
    ADJECTIVE = "adjective"
    ADVERB = "adverb"
    PROPER_NOUN = "proper_noun"
    OTHER = "other"


class Origin(StrEnum):
    MANUAL = "manual"
    EXTRACTION = "extraction"
    IMPORT = "import"
    MIGRATION = "migration"
    SEED = "seed"


class Action(StrEnum):
    CREATED = "created"
    EDITED = "edited"
    DELETED = "deleted"
    ADDED_TO_DOMAIN = "added_to_domain"
    REMOVED_FROM_DOMAIN = "removed_from_domain"
    CARRIED_OVER = "carried_over"
    MOVED = "moved"
    MERGED = "merged"


@dataclass(frozen=True)
class Actor:
    user_id: int | None
    is_admin: bool
    origin: Origin = Origin.MANUAL

    @classmethod
    def system(cls, origin: Origin) -> "Actor":
        return cls(user_id=None, is_admin=True, origin=origin)


class Domain(BaseModel):
    id: int
    name: str
    description: str = ""
    owner_id: int | None = Field(default=None, exclude=True)

    @computed_field  # appears in every API response; owner_id itself does not
    @property
    def is_global(self) -> bool:
        return self.owner_id is None


class ConceptTerm(BaseModel):
    id: int
    uid: str
    text: str
    usage_status: UsageStatus
    process_status: ProcessStatus
    status_reason: str = ""
    context: str = ""
    source: str = ""
    part_of_speech: PartOfSpeech | None = None
    case_sensitive: bool = False
    revision: int = 1
    created_at: str | None = None
    created_by: int | None = None
    modified_at: str | None = None
    modified_by: int | None = None


class LanguageSection(BaseModel):
    id: int
    language: Language
    definition: str = ""
    revision: int = 1
    created_at: str | None = None
    created_by: int | None = None
    modified_at: str | None = None
    modified_by: int | None = None
    terms: list[ConceptTerm]


class Concept(BaseModel):
    id: int
    uid: str
    owner_id: int | None = Field(default=None, exclude=True)
    domain_ids: list[int]
    sections: list[LanguageSection]
    revision: int = 1
    created_at: str | None = None
    created_by: int | None = None
    modified_at: str | None = None
    modified_by: int | None = None

    @computed_field
    @property
    def is_global(self) -> bool:
        return self.owner_id is None


class TermInput(BaseModel):
    id: int | None = None
    text: str
    usage_status: UsageStatus
    process_status: ProcessStatus = ProcessStatus.ACTIVE
    status_reason: str = ""
    context: str = ""
    source: str = ""
    part_of_speech: PartOfSpeech | None = None
    case_sensitive: bool = False

    @field_validator("text")
    @classmethod
    def _text_is_visible(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("a term needs at least one visible character")
        return value

    @classmethod
    def from_term(cls, term: ConceptTerm) -> "TermInput":
        return cls(
            id=term.id,
            text=term.text,
            usage_status=term.usage_status,
            process_status=term.process_status,
            status_reason=term.status_reason,
            context=term.context,
            source=term.source,
            part_of_speech=term.part_of_speech,
            case_sensitive=term.case_sensitive,
        )


class SectionInput(BaseModel):
    language: Language
    id: int | None = None
    revision: int | None = None
    definition: str = ""
    terms: list[TermInput]

    @classmethod
    def from_section(cls, section: LanguageSection) -> "SectionInput":
        return cls(
            language=section.language,
            id=section.id,
            revision=section.revision,
            definition=section.definition,
            terms=[TermInput.from_term(term) for term in section.terms],
        )


class TerminologyRuleError(Exception):
    def __init__(self, rule: str, message: str) -> None:
        super().__init__(message)
        self.rule = rule


class TerminologyConflictError(TerminologyRuleError):
    def __init__(self, part: str, message: str) -> None:
        super().__init__("conflict", message)
        self.part = part


class TransferOutdatedError(TerminologyRuleError):
    def __init__(self, concept_id: int, message: str) -> None:
        super().__init__("outdated", message)
        self.concept_id = concept_id


class SectionBasis(BaseModel):
    id: int
    revision: int


class ConceptBasis(BaseModel):
    concept_id: int
    revision: int
    sections: list[SectionBasis]


class TransferBasis(BaseModel):
    source: ConceptBasis
    target: ConceptBasis | None = None


class MovedTerm(BaseModel):
    id: int
    text: str
    language: Language
    usage_before: UsageStatus
    usage_after: UsageStatus


class DroppedTerm(BaseModel):
    text: str
    language: Language
    usage_status: UsageStatus


class DroppedDefinition(BaseModel):
    language: Language
    definition: str


class DomainRef(BaseModel):
    id: int
    name: str


class TransferOutcome(BaseModel):
    target: Concept
    source: Concept | None
    moved: list[MovedTerm]
    dropped_terms: list[DroppedTerm]
    dropped_definitions: list[DroppedDefinition]
    removed_languages: list[Language]
    dropped_domains: list[DomainRef]
    added_domains: list[DomainRef]
    basis: TransferBasis


def section_label(section: LanguageSection) -> str:
    def first(terms: list[ConceptTerm]) -> str:
        return min(terms, key=lambda t: (t.text.casefold(), t.text)).text

    enforced = [t for t in section.terms if is_enforced(t.process_status)]
    for usage in (UsageStatus.PREFERRED, UsageStatus.ADMITTED):
        matching = [t for t in enforced if t.usage_status == usage]
        if matching:
            return first(matching)
    return first(section.terms)
