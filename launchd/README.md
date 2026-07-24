# Running vault-hud at login (launchd)

Keeps `node server.js` alive on `127.0.0.1:5959` from login onward. `RunAtLoad`
starts it immediately, `KeepAlive` restarts it if it ever exits. Open the installed
PWA window and the server is already serving.

`local.vault-hud.plist` is a **template**: launchd carries no environment and needs
absolute paths, so edit it first and replace every `/ABSOLUTE/PATH/TO` placeholder
(and the `/Users/YOU` log paths) with real values. `which node` gives the node path.

## Install

```bash
# after editing the placeholders in local.vault-hud.plist
cp local.vault-hud.plist ~/Library/LaunchAgents/local.vault-hud.plist
launchctl load ~/Library/LaunchAgents/local.vault-hud.plist
```

Loading starts it. Confirm it is up:

```bash
launchctl list | grep vault-hud
curl -s http://127.0.0.1:5959/api/state | head -c 200
```

## Manage

```bash
launchctl stop  local.vault-hud   # KeepAlive restarts it right away
launchctl start local.vault-hud   # force a restart, picks up code changes
tail -f ~/Library/Logs/vault-hud.log        # logs
```

To pause it properly, unload rather than stop, otherwise `KeepAlive` brings it back:

```bash
launchctl unload ~/Library/LaunchAgents/local.vault-hud.plist   # pause
launchctl load   ~/Library/LaunchAgents/local.vault-hud.plist   # resume
```

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/local.vault-hud.plist
rm ~/Library/LaunchAgents/local.vault-hud.plist
rm -f ~/Library/Logs/vault-hud.log
```

## Notes

- The plist is a copy, not a symlink. After editing the one in this repo, copy it
  over the installed one and `unload` then `load` for the change to take.
- Node path is hardcoded to `/opt/homebrew/bin/node`. If you change Node installs,
  update it in the plist (`which node`).
- launchd carries no environment. The server loads `.env` itself at boot, so
  `VAULT_HUD_VAULT`, `VAULT_HUD_PORT` and the shortcut targets come from there. If
  you would rather set them in launchd, add an `EnvironmentVariables` dict.
- The log is append-only and never rotated. It stays small because the server only
  logs boot and parse errors, but `rm` it if it ever grows.
