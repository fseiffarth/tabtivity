/**
 * The header's button icons: one name per spot, each drawn from the shared set
 * (`common/icons/Icon`, the phone's `glyphs.tsx` pattern). The ✉ 🗓 ☑ ▦ ⚙ these
 * replaced came from whichever fallback font had the code point, so each had
 * its own stroke weight and ink box. A spot's rule sets the size through
 * `className`, which outranks the Frame's width and height attributes.
 */
import {
  BrainIcon,
  CalendarIcon,
  CheckboxIcon,
  ChipIcon,
  GearIcon,
  HelpIcon,
  InboxIcon,
  MachinesIcon,
  MailIcon,
  MeterIcon,
  ShieldIcon,
} from "../common/icons/Icon";

type GlyphProps = { className: string };

export const MailGlyph = ({ className }: GlyphProps) => <MailIcon className={className} />;
export const CalendarGlyph = ({ className }: GlyphProps) => <CalendarIcon className={className} />;
export const TodoGlyph = ({ className }: GlyphProps) => <CheckboxIcon className={className} />;
/** A gauge — the cockpit's every-project overview (`CockpitIndicator`). */
export const CockpitGlyph = ({ className }: GlyphProps) => <MeterIcon className={className} />;
/** A tray — files the phone sent to this desktop (`InboxIndicator`). */
export const InboxGlyph = ({ className }: GlyphProps) => <InboxIcon className={className} />;
export const SettingsGlyph = ({ className }: GlyphProps) => <GearIcon className={className} />;
/** The header's help agent (`HelpAgentButton`). */
export const HelpGlyph = ({ className }: GlyphProps) => <HelpIcon className={className} />;
/** The global machines: the header button and its overlay's bar. */
export const MachinesGlyph = ({ className }: GlyphProps) => <MachinesIcon className={className} />;
/** The machine-wide OpenVPN tunnel, in place of the "VPN" word (`VpnIndicator`). */
export const VpnGlyph = ({ className }: GlyphProps) => <ShieldIcon className={className} />;
/** The Models & agents hub, hosted and local. */
export const BrainGlyph = ({ className }: GlyphProps) => <BrainIcon className={className} />;
/** The Local models section. */
export const ModelsGlyph = ({ className }: GlyphProps) => <ChipIcon className={className} />;
