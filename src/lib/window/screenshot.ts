/** Screenshot helpers: where a saved shot lands. (The delayed-capture countdown
 *  and the in-app PDF region capture went with the header's Screenshot launcher.) */
import { NAMES } from "../brand";

/** The project folder a saved screen grab lands in, mirroring the backend's
 *  `commands::projects::SCREENSHOTS_DIR`. `tabtivity-`prefixed on purpose: a repo
 *  may own a `screenshots/` of its own documentation images, and the scaffold
 *  ignores this folder — ignoring theirs would hide their files from git. */
export const APP_SCREENSHOTS_DIR = NAMES.screenshotsDir;
