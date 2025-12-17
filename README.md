# iobroker-global-Scripte
global lib scripts 

Global-Tools:

 * Global-Tools – Hilfsfunktionen für ilovegyms ioBroker-Umgebung
 * Version: 1.1
 * Typ: global (Bibliothek)
 *
 * Enthält:
 *  - Logging-Helper (gtLog, gtLogDebug, gtSetDebugEnabled, gtIsDebugEnabled)
 *  - State-Helper:
 *      ensureState (kombiniert legacy + async/typed)
 *      ensureStateAsync (typed/async Master)
 *      ensureChannel
 *      getSafeState, getNum, getBool, getStr
 *      setStateIfChanged, setStateSafe
 *  - Format-Helper (fmtBytes, fmtWatt, fmtPercent, fmtDuration, fmtDateTime, fmtNum)
 *  - Datum/Zeit (gtDate, gtTime, gtStartOfDay, gtIsSameDay, gtDaysBetween)
 *  - JSON-Helper (gtJsonParse, gtJsonStringify)
 *  - Array-Helper (deleteDuplicates)
 *  - HTML-Helper (gtEscapeHtml)
 *  - Heartbeat-Helper (hbEnsure, heartbeat, hbOk, hbError)
 *  - SynoChat-Helper:
 *      notifySynoChat, notifySynoChatEx
 *
 * Dieses Script startet KEINE Schedules und registriert KEINE on()-Listener.
 * Es stellt nur Funktionen im globalen Kontext bereit.





_libVoiceGPT:

 * Global helper lib for ioBroker JS adapter.
 * Usage in other scripts: globalThis._libVoiceGpt
 
