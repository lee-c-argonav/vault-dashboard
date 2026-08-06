-- focus-terminal.applescript — bring the Terminal tab owning a given tty to the front.
--
-- The tty arrives as an `on run argv` argument and is never spliced into this
-- script's text, matching how shortcuts.js hands URLs to osascript. It is also
-- validated against a strict pattern before it gets here.
--
-- Returns "ok" when a tab matched, "notfound" otherwise. A caller must treat
-- notfound as a normal outcome: the session may have been closed since the run
-- recorded its tty.

on run argv
  if (count of argv) is 0 then return "notfound"
  set target to item 1 of argv
  -- `tell application` LAUNCHES an app that is not running, so without this a
  -- click with Terminal closed opens a stray window and still returns notfound.
  if application "Terminal" is not running then return "notfound"
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if (tty of t) is target then
          set selected of t to true
          -- `set index of w to 1` looks like it raises the window and does not:
          -- measured 2026-08-06, asking for ttys002 brought ttys005 to the front.
          -- `frontmost` is the property that actually reorders, and it must be
          -- set before activate, or activate raises whatever Terminal last had.
          set frontmost of w to true
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "notfound"
end run
