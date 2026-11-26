# stremio-jellyfin-addon

A small [Stremio](https://www.stremio.com) add-on that plays **your own Jellyfin library** in Stremio.

It lists your Jellyfin movies and series as Stremio catalogs, answers `meta` and `stream` requests, and proxies the video from Jellyfin. The Jellyfin API key stays on the machine that runs the add-on. Stremio only ever sees add-on URLs.

- Zero dependencies. Plain Node.js (18 or newer), about 250 lines in `src/server.js`.
- Tested with the Stremio Android TV app (1.13.0) on the same LAN as the add-on. Desktop and mobile Stremio are not tested.
- No transcoding in v1: Jellyfin serves the original file (`static=true`). The player must support the codecs.
- No subtitles in v1.

## Why

Older community add-ons for this are unmaintained and need a Jellyfin plugin. Jellyfin 12 has no provider-ID filter on `/Items`, so this add-on builds its own in-memory index (IMDb id to Jellyfin item) and refreshes it on a timer.

## How it works

```
Stremio ──http──▶ add-on (this repo) ──Authorization header──▶ Jellyfin
   ▲                    │ catalog / meta / stream
   └── play URL with ───┘ the add-on proxies the video (Range supported)
       add-on token
```

- Catalog items use the IMDb id when Jellyfin knows it (`tt1234567`), otherwise `jf:<jellyfin id>`.
- Episodes use `tt1234567:<season>:<episode>`.
- Box-set members are listed too (`CollapseBoxSetItems=false`).
- Titles that exist twice in Jellyfin appear twice.

## Requirements

- Node.js 18+
- A Jellyfin server (tested with 12.x) and an API key (Jellyfin Dashboard, API Keys)
- Stremio and the add-on host on the same LAN

## Install

1. Save the Jellyfin API key to a file that only you can read:

   ```sh
   mkdir -p ~/.config/stremio-jellyfin-addon
   (umask 077; printf '%s' 'YOUR_JELLYFIN_API_KEY' > ~/.config/stremio-jellyfin-addon/jellyfin-key)
   ```

2. Create the add-on token (a random secret that becomes part of every URL):

   ```sh
   (umask 077; openssl rand -hex 32 > ~/.config/stremio-jellyfin-addon/token)
   ```

3. Start the add-on. `BIND_ADDRESS` must be the LAN address of this machine, because Stremio on another device has to reach it:

   ```sh
   BIND_ADDRESS=192.0.2.20 node src/server.js
   ```

4. In Stremio, open Add-ons, press Install, and enter:

   ```
   http://192.0.2.20:8796/<contents of the token file>/manifest.json
   ```

   The add-on refuses to start when the token or key file is missing, empty, or readable by other users.

### Run it as a service on macOS (launchd)

```sh
BIND_ADDRESS=192.0.2.20 ./install.sh
```

`install.sh` creates the token file if it is missing, writes `~/Library/LaunchAgents/io.github.stremio-jellyfin-addon.plist` (`RunAtLoad`, `KeepAlive`, absolute node path), and starts it. Logs go to `~/Library/Logs/stremio-jellyfin-addon.log`. Example plist:

```xml
<plist version="1.0"><dict>
  <key>Label</key><string>io.github.stremio-jellyfin-addon</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/bin/node</string><string>/path/to/stremio-jellyfin-addon/src/server.js</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>BIND_ADDRESS</key><string>192.0.2.20</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/stremio-jellyfin-addon.log</string>
  <key>StandardErrorPath</key><string>/tmp/stremio-jellyfin-addon.log</string>
</dict></plist>
```

On Linux, use a systemd unit with the same environment variables.

## Configuration

Environment variables (or a `KEY=VALUE` file, see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `BIND_ADDRESS` | `127.0.0.1` | Address to listen on. Use your LAN address, never `0.0.0.0`. |
| `PORT` | `8796` | Listen port |
| `JELLYFIN_URL` | `http://127.0.0.1:8096` | Jellyfin base URL. `https://` and a base path (`https://host/jellyfin`) are supported. |
| `JELLYFIN_KEY_FILE` | `~/.config/stremio-jellyfin-addon/jellyfin-key` | File with the Jellyfin API key (mode 600) |
| `TOKEN_FILE` | `~/.config/stremio-jellyfin-addon/token` | File with the add-on token (mode 600) |
| `REFRESH_SECONDS` | `600` | Index refresh interval |
| `ADDON_ID` | `io.github.stremio-jellyfin-addon` | Stremio add-on id. Changing it makes Stremio treat this as a new add-on. |
| `ADDON_NAME` | `Jellyfin (self-hosted)` | Name shown in Stremio |
| `ENV_FILE` | `~/.config/stremio-jellyfin-addon/env` | Optional `KEY=VALUE` file. Real environment variables win. |

## Security notes

- **LAN only.** Do not expose the add-on to the internet. There is no user login: the token in the URL is the only credential. Anyone who has the install URL can watch your library.
- **The Jellyfin API key stays server-side.** It is read from a file with mode 600, sent to Jellyfin in the `Authorization` header only, and never appears in any response, URL or log. Posters and backdrops are proxied too, so no `api_key` query parameter is ever handed to a client.
- **Token.** 32 random bytes in hex, compared in constant time. Logs replace it with `<token>`. Treat the install URL like a password. To rotate, delete the token file, create a new one, restart, and reinstall the add-on.
- **Tunnel and proxy traffic is refused.** A request carrying `Cf-Connecting-Ip` or `X-Forwarded-For` gets 403, so a Cloudflare tunnel or reverse proxy in front of it cannot publish the add-on by accident.
- **Plain HTTP.** Traffic on your LAN is not encrypted. Stremio's own docs say a URL install needs `127.0.0.1` or HTTPS. The Android TV app accepted a plain LAN `http://` URL in testing. Other Stremio builds may not.
- Bind to one interface. `0.0.0.0` would also publish the add-on on VPN and bridge interfaces.
- The add-on streams only files you already have in Jellyfin. You are responsible for the content in your library.

## Tests

`check.mjs` runs acceptance checks against a running add-on and your real Jellyfin library (see `docs/acceptance-checks.md`):

```sh
ADDON_HOST=192.0.2.20 ./check.sh
```

Useful variables: `JELLYFIN_KEY_FILE`, `TOKEN_FILE`, `LAUNCHD_LABEL` (for the launchd check), `PROJECTOR_ADB=<host:port>` (an Android TV on adb, enables the two on-device checks). Without `PROJECTOR_ADB` those two checks are skipped.

`mutate.sh <M1..M4> <ACn>` breaks a copy of the server on purpose and shows that the matching check goes red.

## License

MIT. See `LICENSE`.
