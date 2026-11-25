// Copyright 2026 Tauric Research
// SPDX-License-Identifier: Apache-2.0
/**
 * The welcome block, the scrollback's first: the mark beside two lines (the name and version, the model
 * and data); then an announcement, if any (news), a line of examples and a line of keys. Left-aligned at the gutter, and
 * written once like any finished block. A narrow window keeps the text and drops the mark.
 */
import { Box, Text } from "ink";
import { APP_TITLE, message, printable } from "../contracts/index.js";
import { SEPARATOR } from "./rows.js";
import { useRoles, useTheme } from "./theme-context.js";

/** Below this many columns the mark is left out. */
const WELCOME_MARK_COLUMNS = 60;

/** The mark, a prompt (`>_`), in the accent; the two lines sit beside its second and fourth rows. */
const MARK = ["▄▖", " ▀▙▖", "  ▄▛▘", "▄▛▘  ▗▄▄▄▖"];
const MARK_WIDTH = Math.max(...MARK.map((row) => row.length));
/** The two lines' rows beside the mark. */
const PLACES = [1, 3];

/**
 * An announcement under the header, every kind the same way: a block of its own, a blank row above it (the
 * examples below keep one above them), the glyph in the brand's touch, its lines in the detail role, wrapped
 * under the text so nothing is cut.
 */
function Announcement({ lines }: { lines: readonly string[] }) {
  const { unicode } = useTheme();
  const roles = useRoles();
  const brand = roles.accent.color ? roles.accent : roles.detail;
  return (
    <Box marginTop={1}>
      <Box width={2} flexShrink={0}>
        <Text {...brand}>{unicode ? "✦" : "*"}</Text>
      </Box>
      <Box flexDirection="column">
        {lines.map((line) => (
          <Text key={line} {...roles.detail}>
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

export function Welcome({
  version,
  model,
  news,
  columns,
}: {
  version: string;
  model: string;
  news?: string | undefined;
  columns: number;
}) {
  const { unicode } = useTheme();
  const roles = useRoles();
  // The brand's touches: in the accent, or secondary without colour.
  const brand = roles.accent.color ? roles.accent : roles.detail;
  const showMark = unicode && columns >= WELCOME_MARK_COLUMNS;
  // The model and data.
  const modelLine = `${printable(model)}${SEPARATOR}${message("app.dataYahoo")}`;
  const lines = [
    <Text key="name" wrap="truncate">
      <Text {...roles.title}>{APP_TITLE}</Text>
      <Text {...roles.detail}>
        {"  "}
        {printable(version)}
      </Text>
    </Text>,
    <Text key="model" {...roles.detail} wrap="truncate">
      {modelLine}
    </Text>,
  ];
  // The news: what is new, or a newer release.
  const announcement = news ? [printable(news)] : undefined;
  // Beside the mark, each line on its row and the other rows blank, so the block is as tall as the mark.
  const beside = MARK.map(
    (_, row) =>
      lines[PLACES.indexOf(row)] ?? (
        // biome-ignore lint/suspicious/noArrayIndexKey: a blank row's place in the fixed block is its identity
        <Text key={`blank${row}`}> </Text>
      ),
  );
  return (
    <Box flexDirection="column" marginBottom={1}>
      {showMark ? (
        <Box>
          <Box flexDirection="column" flexShrink={0} width={MARK_WIDTH} marginRight={3}>
            {MARK.map((row) => (
              <Text key={row} bold {...roles.accent}>
                {row}
              </Text>
            ))}
          </Box>
          <Box flexDirection="column">{beside}</Box>
        </Box>
      ) : (
        lines
      )}
      {announcement ? <Announcement lines={announcement} /> : null}
      <Box flexDirection="column" marginTop={1}>
        <Text {...roles.detail} wrap="truncate">
          {message("app.tryLead")}
          <Text {...brand}>{message("app.tryExamples")}</Text>
        </Text>
        <Box marginTop={1}>
          <Text {...roles.detail} wrap="truncate">
            {message("app.keyHints", { separator: SEPARATOR })}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
