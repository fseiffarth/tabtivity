/** Every sub-panel takes the same two: `onBack` returns to the main settings
 *  panel, `onClose` dismisses the whole dialog. Both optional: the panels are
 *  also rendered standalone in tests, and the Models & agents overlay
 *  (`models/ModelsOverlay`) hosts the Agents and Ollama panels as tabs, where
 *  there is no settings page to go back to (`SettingsHeader` omits Back). */
export interface SubPanelProps {
  onBack?: () => void;
  onClose?: () => void;
}
