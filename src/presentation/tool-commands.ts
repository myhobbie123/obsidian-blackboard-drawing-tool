import type { ToolName } from '../domain/entities';
import { shortcutToolFor } from './text-mode';

/**
 * One selectable tool, exposed as an Obsidian command so it shows up in Settings → Hotkeys,
 * can be rebound, and is scoped/deconflicted by Obsidian rather than by us.
 *
 * No DEFAULT hotkey is registered, for two reasons that point the same way. Obsidian's own
 * guidance (and this repo's review lint) is that plugins should not claim keys the user has
 * not asked for — bare Q/W/E/T are exactly the sort of keys another plugin may want. And a
 * default hotkey would not buy the layout independence we need anyway: Obsidian matches
 * hotkeys on the produced CHARACTER, so a binding registered here is dead the moment the
 * user switches to a Cyrillic layout (long-standing upstream behaviour, tagged wontfix).
 *
 * `code` is the physical key the command answers to through the controller's fallback. That
 * fallback is what preserves the fork's Q/E/T on every layout, and it stands down for any
 * command the user has since rebound, so Obsidian stays in charge of the keyboard.
 */
export interface ToolCommand {
  /** Plugin-local id; Obsidian namespaces it with the plugin id at registration time. */
  id: string;
  name: string;
  tool: ToolName;
  /** `KeyboardEvent.code` of the physical-key fallback, when one applies. */
  code?: string;
}

export const TOOL_COMMANDS: ToolCommand[] = [
  { id: 'select-pen', name: 'Select pen tool', tool: 'pen', code: 'KeyQ' },
  { id: 'select-eraser', name: 'Select eraser tool', tool: 'eraser', code: 'KeyE' },
  { id: 'select-text', name: 'Select text tool', tool: 'text', code: 'KeyT' },
  // The highlighter never had a physical-key shortcut in this fork; giving it one now would
  // silently claim W on every layout for a key nobody has been pressing. It gets the command
  // (bindable like the others) and no fallback.
  { id: 'select-highlighter', name: 'Select highlighter tool', tool: 'highlighter' },
  // Wave 3's tools follow the highlighter's precedent, not the pen's: a command each (so they
  // are bindable and show up in the palette) and NO physical-key fallback, because claiming
  // another five keys on every layout for shortcuts nobody has been pressing is exactly what
  // the no-default-hotkey rule exists to prevent.
  { id: 'select-selection', name: 'Select selection tool', tool: 'select' },
  { id: 'select-line', name: 'Select line tool', tool: 'line' },
  { id: 'select-arrow', name: 'Select arrow tool', tool: 'arrow' },
  { id: 'select-rectangle', name: 'Select rectangle tool', tool: 'rectangle' },
  { id: 'select-ellipse', name: 'Select ellipse tool', tool: 'ellipse' },
];

export function toolCommandFor(tool: ToolName): ToolCommand | null {
  return TOOL_COMMANDS.find((c) => c.tool === tool) ?? null;
}

/**
 * Which tool command a raw keydown should run through the physical-key fallback, or null.
 *
 * Everything about "is this one of ours" is delegated to `shortcutToolFor` (code matching,
 * modifiers, auto-repeat, already-consumed), so the fallback and the pre-command behaviour
 * cannot drift apart. The one added rule is deference: once the user has given the command
 * their own hotkey, Obsidian owns that command's keys and the fallback goes quiet — it must
 * never keep firing a shortcut the user has deliberately moved or removed.
 */
export function fallbackCommandForKey(
  event: Parameters<typeof shortcutToolFor>[0],
  isRebound: (commandId: string) => boolean,
): ToolCommand | null {
  const tool = shortcutToolFor(event);
  if (!tool) return null;
  const command = toolCommandFor(tool);
  if (!command || !command.code || command.code !== event.code) return null;
  return isRebound(command.id) ? null : command;
}

/**
 * Whether the user has customised a command's hotkeys. Obsidian records an entry in
 * `hotkeyManager.customKeys` the moment a command's keys are edited — including an EMPTY
 * list, which is how a removed default is stored. Either way the user has spoken, so the
 * physical-key fallback must stop firing for that command and let Obsidian decide.
 */
export function isCommandRebound(
  customKeys: Record<string, unknown[]> | undefined,
  fullCommandId: string,
): boolean {
  return Array.isArray(customKeys?.[fullCommandId]);
}
