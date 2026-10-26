/**
 * Message action definitions for standardized communication
 */
export class MessageActions {
  // Core actions
  static PING = 'ping';
  static GET_INFO = 'getInfo';
  static HANDLE_ERROR = 'handleError';
  static OPEN_OPTIONS_PAGE = 'openOptionsPage';
  static LAUNCH_EXTENSION_APP = 'launchExtensionApp';
  
  // Translation actions
  static TRANSLATE = 'TRANSLATE';
  static TRANSLATE_SELECTION = 'TRANSLATE_SELECTION';
  static TRANSLATE_PAGE = 'TRANSLATE_PAGE';
  static FETCH_TRANSLATION = 'fetchTranslation';
  static BATCH_TRANSLATE = 'BATCH_TRANSLATE';
  static GET_PROVIDERS = 'GET_PROVIDERS';
  static TEST_PROVIDER = 'TEST_PROVIDER';
  static TRANSLATION_RESULT_UPDATE = 'TRANSLATION_RESULT_UPDATE';
  static TRANSLATION_STREAM_UPDATE = 'TRANSLATION_STREAM_UPDATE';
  static TRANSLATION_STREAM_END = 'TRANSLATION_STREAM_END';
  static TRANSLATE_TEXT = 'TRANSLATE_TEXT';
  static CANCEL_TRANSLATION = 'CANCEL_TRANSLATION';
  static TRANSLATION_CANCELLED = 'TRANSLATION_CANCELLED';
  static CANCEL_SESSION = 'CANCEL_SESSION';
  static PARENT_ACCEPTANCE_ACK = 'PARENT_ACCEPTANCE_ACK';
  static DESKTOP_FAB_GET_STATUS = 'DESKTOP_FAB_GET_STATUS';
  static DESKTOP_FAB_SET_OVERRIDE = 'DESKTOP_FAB_SET_OVERRIDE';
  
  // Subtitle Translation
  static SUBTITLE_TRANSLATE = "SUBTITLE_TRANSLATE";
  static SUBTITLE_TRANSLATE_PROGRESS = "SUBTITLE_TRANSLATE_PROGRESS";
  static SUBTITLE_TRANSLATE_COMPLETE = "SUBTITLE_TRANSLATE_COMPLETE";
  static SUBTITLE_TRANSLATE_ERROR = "SUBTITLE_TRANSLATE_ERROR";
  static SUBTITLE_TRANSLATE_CANCEL = "SUBTITLE_TRANSLATE_CANCEL";

  // Select Element
  static GET_SELECT_ELEMENT_STATE = 'getSelectElementState';
  static GET_SELECT_ELEMENT_FRAME_STATE = 'getSelectElementFrameState';
  static SELECT_ELEMENT_FRAME_READY = 'selectElementFrameReady';
  static SET_SELECT_ELEMENT_STATE = 'setSelectElementState';
  static SELECT_ELEMENT_STATE_CHANGED = 'selectElementStateChanged';
  static PROCESS_SELECTED_ELEMENT = 'PROCESS_SELECTED_ELEMENT';

  // Whole Page Translation (NEW)
  static PAGE_TRANSLATE = 'page-translate';
  static PAGE_TRANSLATE_BATCH = 'page-translate-batch'; // For actual translation request
  static PAGE_TRANSLATE_START = 'page-translate-start';
  static PAGE_TRANSLATE_PROGRESS = 'page-translate-progress';
  static PAGE_TRANSLATE_COMPLETE = 'page-translate-complete';
  static PAGE_TRANSLATE_ERROR = 'page-translate-error';
  static PAGE_TRANSLATE_IDLE = 'page-translate-idle';
  static PAGE_TRANSLATE_RESET_ERROR = 'page-translate-reset-error';
  static PAGE_RESTORE = 'page-restore';
  static PAGE_RESTORE_COMPLETE = 'page-restore-complete';
  static PAGE_RESTORE_ERROR = 'page-restore-error';
  static PAGE_TRANSLATE_CANCELLED = 'page-translate-cancelled';
  static PAGE_TRANSLATE_GET_STATUS = 'page-translate-get-status';
  static PAGE_TRANSLATE_STOP_AUTO = 'page-translate-stop-auto'; // Stop auto-translation (NEW)
  static PAGE_AUTO_RESTORE_COMPLETE = 'page-auto-restore-complete'; // Auto-restore complete (NEW)
  static PAGE_TRANSLATION_FRAME_LIFECYCLE = 'page-translation-frame-lifecycle';
  static PAGE_TRANSLATION_FRAME_RETIRED = 'page-translation-frame-retired';
  static INVALIDATE_PENDING_DISPLAY = 'INVALIDATE_PENDING_DISPLAY';
  static MOUSE_HOVER_FRAME_EVENT = 'MOUSE_HOVER_FRAME_EVENT';
  static MOUSE_HOVER_FRAME_FEEDBACK = 'MOUSE_HOVER_FRAME_FEEDBACK';
  static PAGE_TRANSLATION_FRAME_LIFECYCLE_ACTIONS = Object.freeze([
    'page-translate-start',
    'page-translate-progress',
    'page-translate-complete',
    'page-translate-idle',
    'page-translate-error',
    'page-restore-complete',
    'page-auto-restore-complete',
    'page-translate-cancelled',
    'page-restore-error',
    'page-translation-frame-retired',
  ]);
  static PAGE_TRANSLATION_AGGREGATE_ACTIONS = Object.freeze([
    'page-translate-start',
    'page-translate-progress',
    'page-translate-complete',
    'page-translate-idle',
    'page-translate-error',
    'page-restore-complete',
    'page-auto-restore-complete',
  ]);

  // IFrame Support actions
  static IFRAME_GET_FRAME_INFO = 'IFRAME_GET_FRAME_INFO';
  static IFRAME_COORDINATE_OPERATION = 'IFRAME_COORDINATE_OPERATION';
  static IFRAME_DETECT_TEXT_FIELDS = 'IFRAME_DETECT_TEXT_FIELDS';
  static IFRAME_INSERT_TEXT = 'IFRAME_INSERT_TEXT';
  static IFRAME_SYNC_REQUEST = 'IFRAME_SYNC_REQUEST';
  static IFRAME_SYNC_RESPONSE = 'IFRAME_SYNC_RESPONSE';
  static IFRAME_SELECT_ELEMENT_FINISHED = 'IFRAME_SELECT_ELEMENT_FINISHED';
  
  // Floating Window
  static TRANSLATION_COMPLETE = 'translationComplete';
  
  // Sidepanl
  static OPEN_SIDE_PANEL = 'openSidePanel';
  static SELECTED_TEXT_FOR_SIDEPANEL = 'selectedTextForSidePanel';

  // History actions
  static GET_HISTORY = 'GET_HISTORY';
  static CLEAR_HISTORY = 'CLEAR_HISTORY';
  static ADD_TO_HISTORY = 'ADD_TO_HISTORY';
  
  // Popup
  static Set_Exclude_Current_Page = 'setExcludeCurrentPage';
  static IS_Current_Page_Excluded = 'isCurrentPageExcluded';
  
  // TTS actions
  static GOOGLE_TTS_SPEAK = 'GOOGLE_TTS_SPEAK';
  static TTS_STOP = 'TTS_STOP';
  static GOOGLE_TTS_GET_STATUS = 'GOOGLE_TTS_GET_STATUS';
  static GOOGLE_TTS_ENDED = 'GOOGLE_TTS_ENDED';
  static INTERNAL_TTS_CHUNK_FINISHED = 'INTERNAL_TTS_CHUNK_FINISHED';
  static TTS_LANG_DETECTED = 'TTS_LANG_DETECTED';
  static PLAY_OFFSCREEN_AUDIO = 'playOffscreenAudio';
  static OFFSCREEN_READY = 'OFFSCREEN_READY';

  // Live dubbing control plane (Chrome only)
  static START_LIVE_DUBBING = 'START_LIVE_DUBBING';
  static STOP_LIVE_DUBBING = 'STOP_LIVE_DUBBING';
  static GET_LIVE_DUBBING_STATUS = 'GET_LIVE_DUBBING_STATUS';
  static LIVE_DUBBING_START = 'LIVE_DUBBING_START';
  static LIVE_DUBBING_STOP = 'LIVE_DUBBING_STOP';
  static LIVE_DUBBING_GET_STATUS = 'LIVE_DUBBING_GET_STATUS';
  static LIVE_DUBBING_PREPARE = 'LIVE_DUBBING_PREPARE';
  static LIVE_DUBBING_CONSUME = 'LIVE_DUBBING_CONSUME';
  static LIVE_DUBBING_DISPOSE = 'LIVE_DUBBING_DISPOSE';
  static LIVE_DUBBING_STATUS = 'LIVE_DUBBING_STATUS';
  static LIVE_DUBBING_REQUEST_PROVIDER_BOOTSTRAP = 'LIVE_DUBBING_REQUEST_PROVIDER_BOOTSTRAP';
  static LIVE_DUBBING_VALIDATE_CREDENTIAL = 'LIVE_DUBBING_VALIDATE_CREDENTIAL';
  
  // Capture actions
  static SCREEN_CAPTURE = 'SCREEN_CAPTURE';
  static START_SCREEN_CAPTURE = 'START_SCREEN_CAPTURE';
  static CAPTURE_FULL_SCREEN = 'CAPTURE_FULL_SCREEN';
  static START_CAPTURE_SELECTION = 'START_CAPTURE_SELECTION';
  static PROCESS_IMAGE_OCR = 'PROCESS_IMAGE_OCR';
  static CAPTURE_TRANSLATION_COMPLETED = 'CAPTURE_TRANSLATION_COMPLETED';
  static CAPTURE_SAVE_TRANSLATION = 'CAPTURE_SAVE_TRANSLATION';
  static SCREEN_CAPTURE_CANCELLED = 'SCREEN_CAPTURE_CANCELLED';
  static PROCESS_SCREEN_CAPTURE = 'PROCESS_SCREEN_CAPTURE';
  static START_AREA_CAPTURE = 'START_AREA_CAPTURE';
  static CAPTURE_SCREEN_AREA = 'CAPTURE_SCREEN_AREA';
  static OCR_PROCESS = 'OCR_PROCESS';
  static START_SCREEN_AREA_SELECTION = 'START_SCREEN_AREA_SELECTION';
  static SCREEN_CAPTURE_OCR_RESULT = 'SCREEN_CAPTURE_OCR_RESULT';
  static SYNC_OCR_DOWNLOADABLE_LANGUAGES = 'SYNC_OCR_DOWNLOADABLE_LANGUAGES';
  
  // Selection actions
  static ACTIVATE_SELECT_ELEMENT_MODE = 'activateSelectElementMode';
  static DEACTIVATE_SELECT_ELEMENT_MODE = 'deactivateSelectElementMode';
  static REVERT_SELECT_ELEMENT_MODE = 'revertTranslation';
  static GET_SELECTED_TEXT = 'GET_SELECTED_TEXT';
  
  // Notification actions
  static SHOW_NOTIFICATION = 'SHOW_NOTIFICATION';
  static DISMISS_NOTIFICATION = 'DISMISS_NOTIFICATION';
  static SHOW_ERROR_NOTIFICATION = 'SHOW_ERROR_NOTIFICATION';
  static SHOW_NOTIFICATION_SIMPLE = 'showNotification';
  
  // Context Menu actions
  static REFRESH_CONTEXT_MENUS = 'REFRESH_CONTEXT_MENUS';
  static CONTEXT_MENU_TRANSLATE_ELEMENT = 'CONTEXT_MENU_TRANSLATE_ELEMENT';
  static CONTEXT_MENU_TRANSLATE_TEXT = 'CONTEXT_MENU_TRANSLATE_TEXT';
  
  // Storage actions
  static GET_SETTINGS = 'GET_SETTINGS';
  static SET_SETTINGS = 'SET_SETTINGS';
  static SETTINGS_UPDATED = 'SETTINGS_UPDATED';
  static SET_PROVIDER_CATEGORY_COLLAPSED = 'SET_PROVIDER_CATEGORY_COLLAPSED';
  static SPA_NAVIGATION = 'SPA_NAVIGATION';
  
  // Provider actions
  static TEST_PROVIDER_CONNECTION = 'TEST_PROVIDER_CONNECTION';
  static TEST_CUSTOM_CONNECTION = 'TEST_CUSTOM_CONNECTION';
  static GET_PROVIDER_CONFIG = 'GET_PROVIDER_CONFIG';
  static UPDATE_PROVIDER_CONFIG = 'UPDATE_PROVIDER_CONFIG';
  static SET_ACTIVE_PROVIDER = 'SET_ACTIVE_PROVIDER';
  static GET_PROVIDER_CAPABILITIES = 'GET_PROVIDER_CAPABILITIES';
  static VALIDATE_API_KEY = 'VALIDATE_API_KEY';
  
  // Service actions
  static GET_SERVICE_STATUS = 'GET_SERVICE_STATUS';
  static INITIALIZE_SERVICE = 'INITIALIZE_SERVICE';
  static RESTART_SERVICE = 'RESTART_SERVICE';
  static GET_SERVICE_CONFIG = 'GET_SERVICE_CONFIG';
  static UPDATE_SERVICE_CONFIG = 'UPDATE_SERVICE_CONFIG';
  static GET_SERVICE_METRICS = 'GET_SERVICE_METRICS';
  static CLEAR_SERVICE_CACHE = 'CLEAR_SERVICE_CACHE';
  static GET_TRANSLATION_HISTORY = 'GET_TRANSLATION_HISTORY';
  static CLEAR_TRANSLATION_HISTORY = 'CLEAR_TRANSLATION_HISTORY';
  static EXPORT_SERVICE_DATA = 'EXPORT_SERVICE_DATA';
  static IMPORT_SERVICE_DATA = 'IMPORT_SERVICE_DATA';
  
  // Background actions
  static WARMUP_BACKGROUND_SERVICES = 'WARMUP_BACKGROUND_SERVICES';
  static GET_BACKGROUND_STATUS = 'GET_BACKGROUND_STATUS';
  static RESTART_BACKGROUND = 'RESTART_BACKGROUND';
  static GET_BACKGROUND_METRICS = 'GET_BACKGROUND_METRICS';
  static CLEAR_BACKGROUND_CACHE = 'CLEAR_BACKGROUND_CACHE';
  static SCHEDULE_BACKGROUND_TASK = 'SCHEDULE_BACKGROUND_TASK';
  static CANCEL_BACKGROUND_TASK = 'CANCEL_BACKGROUND_TASK';
  static GET_BACKGROUND_LOGS = 'GET_BACKGROUND_LOGS';
  static SET_BACKGROUND_CONFIG = 'SET_BACKGROUND_CONFIG';
  static GET_MEMORY_STATS = 'GET_MEMORY_STATS';
  static FORCE_GARBAGE_COLLECTION = 'FORCE_GARBAGE_COLLECTION';

  // Debug & Logging actions
  static DEBUG_MODE_CHANGED = 'DEBUG_MODE_CHANGED';
  static COMPONENT_LOG_LEVELS_CHANGED = 'COMPONENT_LOG_LEVELS_CHANGED';
  static OFFSCREEN_LOGGING_SETTINGS_GET = 'OFFSCREEN_LOGGING_SETTINGS_GET';
  static OFFSCREEN_LOGGING_SETTINGS_UPDATED = 'OFFSCREEN_LOGGING_SETTINGS_UPDATED';

  /**
   * Get all available actions
   * @returns {Array<string>} Array of action names
   */
  static getAllActions() {
    return Object.values(this);
  }

  /**
   * Validate action name
   * @param {string} action - Action to validate
   * @returns {boolean} True if action is valid
   */
  static isValidAction(action) {
    return this.getAllActions().includes(action);
  }
}
