import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import {
  stopVoiceSession,
  voiceDeviceLabel,
  voiceInputOffered,
  watchVoiceDevice,
  watchVoiceOwner,
  type OwnerEvent,
  type VoiceDevice,
} from "../../lib/voice/desktopVoice";
import { UntestedTag } from "../common/UntestedTag";

/**
 * The microphone's machine-wide state (docs/desktop_voice_plan.md, step 3):
 * one Chat tab at a time holds it, in any window. Drawn only while it is on,
 * and never folded behind the status cluster's chevron — a live mic is not
 * a readout to hide. A click stops it.
 */
export function VoiceIndicator() {
  const t = useT();
  const [owner, setOwner] = useState<OwnerEvent | null>(null);
  const [device, setDevice] = useState<VoiceDevice | null>(null);
  useEffect(() => (voiceInputOffered() ? watchVoiceOwner(setOwner) : undefined), []);
  useEffect(() => (voiceInputOffered() ? watchVoiceDevice(setDevice) : undefined), []);
  if (!owner?.session || !owner.owner) return null;
  const session = owner.session;
  const stop = t("terminal.reader.voice.indicator");
  const label = device ? `${stop} · ${voiceDeviceLabel(device, t)}` : stop;
  return (
    <button
      type="button"
      className="global-apps-menu-btn voice-indicator"
      title={label}
      aria-label={label}
      onClick={() => void stopVoiceSession(session).catch(() => setOwner(null))}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
        <path d="M6 11a6 6 0 0 0 12 0M12 17v4M8 21h8" />
      </svg>
      <UntestedTag id="terminal.reader.voice.indicator" />
    </button>
  );
}
