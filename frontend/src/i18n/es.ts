import type { Messages } from './messages'

const sev = { error: 'error', warning: 'advertencia', suggestion: 'sugerencia' }
const sevPlural = {
  error: 'errores',
  warning: 'advertencias',
  suggestion: 'sugerencias',
}
const categories = {
  spelling: 'ortografía',
  grammar: 'gramática',
  style: 'estilo',
  clarity: 'claridad',
  vividness: 'viveza',
  correctness: 'corrección',
  terminology: 'terminología',
}
const scopes: Record<string, string> = {
  sentence: 'oración',
  paragraph: 'párrafo',
  document: 'documento',
}

export const es: Messages = {
  viewEditor: 'Editor',
  viewRules: 'Reglas',
  viewTerminology: 'Terminología',
  language: 'Idioma',
  domain: 'Dominio',
  llm: 'LLM',
  model: 'Modelo',
  domainNone: 'ninguno',
  offlineSuffix: ' (sin conexión)',
  autoTitle: 'Ejecutar la comprobación LLM automáticamente tras una pausa',
  loadExample: 'Cargar texto de ejemplo',
  exampleTitle:
    'Reemplazar el contenido del editor por un texto de ejemplo con errores para el idioma seleccionado',
  check: 'Comprobar',
  checking: 'Comprobando…',
  basicChecksOnly: (name) => `${name} (solo comprobaciones básicas)`,
  uiLocaleTitle: 'Idioma de la interfaz',
  profile: 'Perfil',
  profileModifiedTitle: 'La configuración difiere del perfil',
  saveToProfile: 'Guardar los cambios en el perfil',
  resetToProfile: 'Restablecer los valores del perfil',
  domainsSelected: (n) => `${n} dominios`,
  viewProfiles: 'Perfiles',
  viewAdmin: 'Admin',
  adminUsersTitle: 'Gestión de usuarios',
  tierName: (t) =>
    ({ quality: 'Máxima calidad', balanced: 'Equilibrado', cheap: 'Rápido y económico', local: 'Privado (local)' })[t],
  tierPinnedOption: (model) => `Fijado: ${model}`,
  resolvedModel: (model, provider) => `→ ${model} (${provider})`,
  advanced: 'Avanzado',
  pinnedNote: 'Un modelo fijado anula los niveles',
  clearPin: 'Quitar fijación',
  llmSkipped: (reason) => `Comprobación LLM omitida: ${reason}`,
  pinThisModel: 'Fijar este modelo',
  advancedTitle: 'Selección avanzada de modelo',
  planSuffix: ' (no incluido en el plan)',
  llmDegraded: (effective, requested) =>
    `La verificación LLM se ejecutó con ${effective} — ${requested} no está disponible en el plan actual.`,
  llmNotIncluded: 'La verificación LLM no está incluida en el plan actual.',
  llmSkippedServer: 'Verificación LLM omitida: no disponible en el servidor.',
  serverBusy: 'Servidor ocupado; vuelva a intentarlo en unos instantes.',
  llmQuotaExhausted: (limit) =>
    `Cuota diaria de comprobaciones LLM agotada (${limit}). Se restablece a medianoche (UTC).`,
  llmDocumentTooLarge: (limit) =>
    `El texto supera el límite LLM de ${limit.toLocaleString('es-ES')} caracteres.`,
  quotaIndicatorTitle: 'Comprobaciones LLM utilizadas hoy',
  charCount: (n) => `${n.toLocaleString('es-ES')} caracteres`,
  charCountOverLlm: 'por encima del límite LLM',
  charCountOverDoc: 'por encima del límite del documento',

  findings: 'Resultados',
  fastChecking: 'comprobando…',
  llmChecking: (elapsed, tokens) =>
    tokens === null
      ? `Comprobación LLM… (${elapsed})`
      : `Comprobación LLM… (${elapsed} · ↓ ${tokens.toLocaleString('es-ES')} tokens)`,
  severityName: (s) => sev[s],
  severityCount: (s, n) => (n === 1 ? `1 ${sev[s]}` : `${n} ${sevPlural[s]}`),
  showOnlySeverity: (s) => `Mostrar solo ${sevPlural[s]}`,
  showAllFindings: 'Haz clic para mostrar de nuevo todos los resultados',
  sourceGroupCount: (g, n) => (g === 'llm' ? `${n} LLM` : `${n} por reglas`),
  showOnlySource: (g) =>
    g === 'llm'
      ? 'Mostrar solo resultados del LLM'
      : 'Mostrar solo resultados basados en reglas',
  llmCheckFailed: (error) => `Falló la comprobación LLM: ${error}`,
  allClear: 'No se encontraron problemas. ¡Fabuloso!',
  noFilterMatch: 'Ningún resultado coincide con el filtro actual.',
  categoryName: (c) => categories[c],
  sourceName: (source) =>
    source === 'llm' ? 'LLM' : source === 'rule' ? 'regla' : 'terminología',
  askingLlm: 'consultando al LLM…',
  noReplacement: 'El LLM no encontró ningún reemplazo.',
  suggestFix: 'Sugerir corrección',
  retrySuggestion: 'Reintentar sugerencia',
  rewriting: 'reescribiendo la oración…',
  noRewrite: 'El LLM no ofreció ninguna reescritura.',
  rewriteSentence: 'Reescribir oración',
  retryRewrite: 'Reintentar reescritura',
  applyRewriteTitle: 'Reemplazar la oración por esta reescritura',
  sentenceChangedRewriteAgain: 'La oración cambió — reescribe de nuevo.',
  noReliableSuggestion: (rejected) =>
    `Ninguna sugerencia fiable — ${
      rejected === 1 ? '1 candidato no superó' : `${rejected} candidatos no superaron`
    } las comprobaciones locales.`,
  showHeldBack: (count) =>
    count === 1 ? 'Mostrar 1 sugerencia retenida' : `Mostrar ${count} sugerencias retenidas`,
  heldBackRules: (rules) => `Seguiría activando: ${rules}`,
  heldBackSpelling: (words) => `No reconocido: ${words}`,
  scoreBadgeTitle: 'Calidad general — clic para ver detalles',
  scoreTooShort: 'Demasiado corto para puntuar (mínimo 40 palabras)',
  scoreMechanicsOnly: 'Solo mecánica — ejecuta una comprobación LLM para la puntuación completa',
  scoreOutdated: 'La valoración de oficio es anterior a los últimos cambios',
  scoreMechanics: 'Mecánica',
  scoreCraft: 'Oficio',
  dimensionName: (d) =>
    ({
      consistency: 'consistencia',
      flow: 'fluidez',
      clarity: 'claridad',
      vividness: 'viveza',
      tone: 'tono',
      structure: 'estructura',
    })[d],

  globalBadge: 'Integrado',
  globalBadgeTitle: 'Elemento integrado — solo los administradores pueden modificarlo',

  domains: 'Dominios',
  newDomainPlaceholder: 'Nuevo dominio…',
  add: 'Añadir',
  deleteDomainTitle: 'Eliminar dominio',
  terms: 'Términos',
  searchTermsPlaceholder: 'Buscar términos…',
  allLanguages: 'Todos los idiomas',
  langHeader: 'Idioma',
  preferredHeader: 'Preferido',
  doNotUseHeader: 'No usar',
  definitionHeader: 'Definición',
  sortHeaderTitle: 'Haz clic para ordenar: ascendente → descendente → desactivado',
  languageFilterTitle: 'Mostrar solo los términos de un idioma',
  noTermsMatch: 'Ningún término coincide con el filtro actual.',
  preferredPlaceholder: 'término preferido',
  forbiddenPlaceholder: 'prohibidos, separados por comas',
  definitionPlaceholder: 'definición (opcional)',
  deleteTermTitle: 'Eliminar término',
  caseSensitiveTitle: 'Distinguir mayúsculas y minúsculas',
  editTermTitle: 'Editar término',
  saveEditTitle: 'Guardar cambios',
  cancelEditTitle: 'Descartar cambios',
  renameDomainTitle: 'Renombrar dominio',
  changeFailed: (error) => `No se pudo aplicar el cambio: ${error}`,

  profilesTitle: 'Perfiles de comprobación',
  newProfilePlaceholder: 'Nuevo perfil…',
  createProfileTitle: 'Crear a partir de la configuración actual',
  deleteProfileTitle: 'Eliminar perfil',
  resetStandardTitle: 'Restablecer valores predeterminados',
  llmInstructionsLabel: 'Instrucciones LLM adicionales',
  llmInstructionsHint:
    'Se añaden al prompt de comprobación integrado (tono, audiencia, enfoque)',
  exampleTextLabel: 'Texto de ejemplo',
  profileChangeFailed: (error) => `No se pudo aplicar el cambio de perfil: ${error}`,

  rulesTitle: 'Reglas',
  rulesHint:
    'Comprobaciones deterministas para el idioma seleccionado en la cabecera. Las reglas están en {path} y se recargan al reiniciar el servidor o mediante {endpoint}.',
  couldNotLoadRules: (error) => `No se pudieron cargar las reglas: ${error}`,
  filesWithErrors: 'Archivos con errores',
  nlpBadgeTitle: 'Requiere el modelo spaCy del idioma',
  pattern: 'Patrón',
  detailFlags: (listed, omittedTotal) =>
    omittedTotal === null
      ? `Señala: ${listed}`
      : `Señala: ${listed} … (${omittedTotal} en total)`,
  detailAdjacentRepeated: 'Palabras repetidas consecutivas',
  detailTokenPattern: (size) => `Patrón de tokens de spaCy (${size} tokens)`,
  detailDependencyPattern: (size) => `Patrón de dependencias de spaCy (${size} nodos)`,
  detailOccurrence: (kind, bound, what, pattern, scope) => {
    const quantity = kind === 'more' ? `Más de ${bound}` : `Menos de ${bound}`
    const counted = what === 'tokens' ? 'tokens' : `coincidencias de /${pattern}/`
    return `${quantity} ${counted} por ${scopes[scope] ?? scope}`
  },
  editingRulesFor: (p, l) => `Editando reglas para: ${p} (${l})`,
  categoryToggleTitle: 'Activar/desactivar toda la categoría para el perfil',
  ruleToggleTitle: 'Activar/desactivar esta regla para el perfil',
  rulePacks: 'Paquetes de reglas',
  packName: (slug) =>
    ({ marketing: 'Marketing', techdocs: 'Doc. técnica', blog: 'Blog' })[slug] ??
    slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' '),
  packToggleTitle: 'Activar o desactivar este paquete para el perfil seleccionado',
  expandAllTitle: 'Expandir todas las secciones',
  collapseAllTitle: 'Contraer todas las secciones',
  exampleFlagged: 'Señala',
  exampleNotFlagged: 'No señala',

  docNew: 'Documento nuevo',
  docUntitled: 'Sin título',
  docRecovered: (name) => `${name} (recuperado)`,
  docRename: 'Renombrar',
  docDelete: 'Eliminar',
  docDeleteConfirm: (name) => `¿Eliminar «${name}»? Esta acción no se puede deshacer.`,
  docListError: 'No se pudieron cargar los documentos.',
  docRetry: 'Reintentar',
  docSidebarShow: 'Mostrar documentos',
  docSidebarHide: 'Ocultar documentos',
  docMenu: 'Acciones del documento',
  folderNew: 'Carpeta nueva',
  folderNamePlaceholder: 'Nombre de la carpeta',
  folderRename: 'Renombrar',
  folderDelete: 'Eliminar carpeta',
  folderDeleteConfirm: (name) =>
    `¿Eliminar la carpeta «${name}»? Sus documentos se conservarán y saldrán de la carpeta.`,
  folderNewDocument: 'Documento nuevo aquí',
  folderMoveTo: 'Mover a carpeta',
  folderNone: 'Sin carpeta',
  folderMenu: 'Acciones de carpeta',
  folderDefaults: 'Valores predeterminados de la carpeta',
  folderDefaultsNone: '— sin valor predeterminado —',
  folderDefaultsTakeCurrent: 'Tomar del documento actual',
  folderDefaultsAuto: 'Comprobación automática',
  folderDefaultsAutoOn: 'Activada',
  folderDefaultsAutoOff: 'Desactivada',
  folderDefaultsSave: 'Guardar',
  folderDefaultsCancel: 'Cancelar',
  folderDefaultsError: 'No se pudieron guardar los valores predeterminados de la carpeta.',

  // Autenticación
  signInEmail: 'Correo electrónico',
  signInPassword: 'Contraseña',
  signInSubmit: 'Iniciar sesión',
  signInPending: 'Iniciando sesión…',
  signInInvalid: 'Correo electrónico o contraseña incorrectos.',
  signInFailed: 'No se pudo iniciar sesión. Vuelva a intentarlo.',
  sessionExpired:
    'La sesión ha finalizado. Inicie sesión de nuevo: los cambios sin guardar se han conservado.',
  accountMenu: 'Cuenta',
  accountChangePassword: 'Cambiar contraseña',
  accountLogOut: 'Cerrar sesión',
  passwordCurrent: 'Contraseña actual',
  passwordNew: 'Nueva contraseña',
  passwordConfirm: 'Confirmar nueva contraseña',
  passwordSubmit: 'Cambiar contraseña',
  passwordCancel: 'Cancelar',
  passwordMismatch: 'Las nuevas contraseñas no coinciden.',
  passwordTooShort: (min) => `La nueva contraseña debe tener al menos ${min} caracteres.`,
  passwordCurrentWrong: 'La contraseña actual no es correcta.',
  passwordChanged: 'Contraseña cambiada.',
  passwordFailed: 'No se pudo cambiar la contraseña.',
  connectionFailed: 'No se puede conectar con el servidor.',
  connectionRetry: 'Reintentar',
}
