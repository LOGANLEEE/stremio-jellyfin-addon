# Acceptance checks

`check.mjs` runs these against a running add-on and a real Jellyfin library. Counts are compared with what Jellyfin itself reports.

| ID | Check |
|---|---|
| AC0 | (optional TV) Stremio on a TV accepts the add-on URL: screenshot `evidence/ac0-install.png` exists |
| AC1 | Catalog `movie` has one entry per Jellyfin Movie (count equal) with name, id and an add-on poster URL |
| AC2 | Catalog `series` has one entry per Jellyfin Series |
| AC3 | Catalog search returns the known movie and no unrelated title |
| AC4 | Meta for a series lists a video per Jellyfin episode, ids `tt...:season:episode` |
| AC5 | Stream for a movie IMDb id returns one URL that answers `Range: bytes=0-1023` with 206 and 1024 bytes |
| AC6 | Stream for an episode id returns a playable URL |
| AC7 | Stream for an unknown id returns 200 and an empty list |
| AC8 | The Jellyfin key appears in no response body or header, no URL has `api_key`, and the log has neither |
| AC9 | A wrong token returns 403 or 404 and sends no video bytes. The compare is constant-time. Logs hide the token |
| AC10 | A request with `Cf-Connecting-Ip` or `X-Forwarded-For` gets 403 |
| AC11 | Manifest has `Access-Control-Allow-Origin: *`, resources catalog, meta, stream, types movie, series |
| AC12 | With Jellyfin down: empty catalog at first start, cached catalog afterwards, 502/503 on play, process stays up |
| AC13 | launchd agent has `RunAtLoad`, `KeepAlive`, absolute node path, and comes back after `kill` and after `bootout`/`bootstrap` |
| AC14 | (optional TV) the TV reaches the manifest over the LAN (adb shell, `toybox nc`) |
| AC15 | The add-on listens on the configured LAN address only, not on `*`, not on 127.0.0.1 |
| AC16 | Stream URLs are built from the request `Host` header |
| AC17 | The add-on exits non-zero and names the file when the token or key file is missing, empty, or not mode 600 |
| AC18 | An episode id with no Jellyfin match returns an empty list |
| AC19 | Jellyfin behind HTTPS and a base path (`https://host/jf/`): the add-on uses TLS, keeps the path prefix and sends the Authorization header |
| AC20 | An image kind such as `constructor` or `__proto__` returns 404 |

Run one check: `ADDON_HOST=<lan address> node check.mjs AC9`.
