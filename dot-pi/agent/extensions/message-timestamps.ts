// message-timestamps.ts
//
// A dim wall clock above every user and assistant message — `11/27 12:53pm` —
// so a session read hours after it settled still says when each exchange
// happened. The footer only ever describes "now", which is exactly the fact
// that stops being true the moment you look away.
//
// The time belongs to the message, not to the render: pi hands a markdown
// transformer the session entry's ISO timestamp when it repaints a restored
// message, so a stamp is static and survives a restart. A live message has no
// entry timestamp yet, so `message_start` records one per role and the message
// reuses it — a label that moved while a reply streamed would be worse than
// none. The lazy branch covers the one ordering pi does not promise: a message
// painted before its own `message_start`.
//
// Dim arrives as the palette's dim slot (ANSI 90) in the Markdown source. SGR 2
// (faint) is the shorter spelling, but terminals routinely ignore it for 24-bit
// text, which is why it read as ordinary output; 90 is what every palette and
// theme puts its own "quieter" colour in, so the stamp follows the terminal
// rather than arguing with it. `theme.fg("dim")` is out of reach here — a
// markdown transformer is handed no theme — and a hardcoded grey would fight a
// light background. The markdown renderer styles each line separately, so
// closing the run with `\x1b[39m` recolours only this stamp and never the
// message below it.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FAINT = "\x1b[90m";
const FAINT_OFF = "\x1b[39m";

/** The transcript surfaces a stamp belongs above. Thinking blocks keep their own label. */
const STAMPED = ["user", "assistant"] as const;

/** `11/27 12:53pm`, or `25/11/27 12:53pm` for a year other than this one. */
export function formatStamp(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const hours = date.getHours();
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  const clock = `${hours % 12 === 0 ? 12 : hours % 12}:${minute}${hours < 12 ? "am" : "pm"}`;
  const monthDay = `${date.getMonth() + 1}/${date.getDate()}`;
  return date.getFullYear() === new Date(now).getFullYear()
    ? `${monthDay} ${clock}`
    : `${`${date.getFullYear()}`.slice(-2)}/${monthDay} ${clock}`;
}

export default function (pi: ExtensionAPI) {
  /** Newest live message's stamp, per role: the only clock a message without an entry timestamp has. */
  const liveStamp = new Map<string, string>();

  const remember = (role: unknown, timestamp: unknown): void => {
    if (role !== "user" && role !== "assistant") return;
    liveStamp.set(role, formatStamp(typeof timestamp === "number" ? timestamp : Date.now()));
  };

  pi.on("message_start", (event) => {
    const message = event.message as { role?: unknown; timestamp?: unknown };
    remember(message.role, message.timestamp);
  });

  pi.registerMarkdownTransformer(
    (markdown, { messageType, timestamp }) => {
      if (!markdown.trim()) return markdown;
      // A restored message names its own entry; a live one borrows the clock its
      // `message_start` recorded, and stamps itself if it was painted first.
      const persisted = timestamp ? formatStamp(Date.parse(timestamp)) : "";
      let label = persisted;
      if (!label) {
        label = liveStamp.get(messageType) ?? "";
        if (!label) {
          label = formatStamp(Date.now());
          liveStamp.set(messageType, label);
        }
      }
      return label ? `${FAINT}${label}${FAINT_OFF}\n\n${markdown}` : markdown;
    },
    { messageTypes: [...STAMPED] },
  );
}
