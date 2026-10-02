// Share conversation behavior, not origin-specific endpoints or credentials.
export const settingFields = `
mainPrompt jailbreak globalNote temperature maxContext maxResponse frequencyPenalty
PresensePenalty formatingOrder jailbreakToggle loreBookDepth loreBookToken loreBook
username userIcon userNote personaPrompt personas selectedPersona personaNote
additionalPrompt descriptionPrefix promptPreprocess bias globalscript enabledModules
useStreaming ollamaModel ollamaThinkingMode webuiFastGeneration promptTemplate promptSettings
top_p top_k repetition_penalty min_p top_a generationSeed localStopStrings
useInstructPrompt instructChatTemplate JinjaTemplate customPromptTemplateToggle
templateDefaultVariables moduleIntergration presetRegex reasoningEffort thinkingTokens
thinkingType adaptiveThinkingEffort deepseekThinkingType deepseekReasoningEffort
jsonSchemaEnabled jsonSchema strictJsonSchema extractJson groupOtherBotRole groupTemplate
seperateParametersEnabled seperateParameters systemContentReplacement systemRoleReplacement
customFlags enableCustomFlags verbosity dynamicOutput additionalParams
autoContinueChat autoContinueMinTokens removeIncompleteResponse
hypaMemory hypav2 memoryAlgorithmType supaMemoryPrompt hypaModel hypaV3Settings
hypaV3 hypaV3Presets hypaV3PresetId hypaAllocatedTokens hypaChunkSize
useAutoSuggestions autoSuggestPrompt autoSuggestPrefix autoSuggestClean
`.trim().split(/\s+/);

// A preset's prompt toggles (its checkboxes and selects) are not kept in the
// preset or in any setting above: RisuAI stores what was chosen as
// `toggle_<key>` entries in globalChatVariables. Without them the prompt text
// was shared and the choices were not -- the same preset built a different
// prompt on the phone. Only the toggles travel; the other global variables
// belong to whatever script set them, on that device.
const TOGGLE = /^toggle_/;
export const promptToggles = db => Object.fromEntries(
  Object.entries(db.globalChatVariables || {}).filter(([key]) => TOGGLE.test(key)).sort(([a], [b]) => a.localeCompare(b)),
);

export function syncSettings(db) {
  const settings = Object.fromEntries(settingFields.filter(key => db[key] !== undefined).map(key => [key, db[key]]));
  const preset = db.botPresets?.[db.botPresetsId];
  if (preset) settings.activePreset = preset.name;
  const toggles = promptToggles(db);
  if (Object.keys(toggles).length) settings.promptToggles = toggles;
  return settings;
}

export function applySyncSettings(db, settings = {}) {
  for (const key of settingFields) {
    if (Object.hasOwn(settings, key)) db[key] = settings[key];
  }
  if (settings.promptToggles && typeof settings.promptToggles === 'object') {
    const kept = Object.fromEntries(Object.entries(db.globalChatVariables || {}).filter(([key]) => !TOGGLE.test(key)));
    const toggles = Object.fromEntries(Object.entries(settings.promptToggles).filter(([key, value]) => TOGGLE.test(key) && typeof value === 'string'));
    db.globalChatVariables = { ...kept, ...toggles };
  }
  if (typeof settings.activePreset === 'string') {
    const index = db.botPresets.findIndex(preset => preset.name === settings.activePreset);
    if (index >= 0) db.botPresetsId = index;
  }
}
