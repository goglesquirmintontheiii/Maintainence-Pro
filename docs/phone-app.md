# The phone app: devices, browsers and offline mode

MPro's phone app is the web app installed to the home screen (a progressive web app). There's nothing to download
from an app store: open MPro in the phone's browser and choose **Add to Home Screen** (iPhone and iPad: Share →
Add to Home Screen; Android: the browser menu → Install app). It then opens full screen, like any other app.

The server must be reached over **HTTPS** (or `localhost`) for phones to install it and to work offline. A plain
`http://192.168.x.x:8080` address works in the browser but can't be installed or used offline.

## Supported devices and browsers (r288, r289)

| | Supported |
|---|---|
| Phones and tablets | iOS / iPadOS 16.4 or newer (Safari); Android 7.0 or newer (Chrome) |
| Computers | the last 5 versions of Chrome, Edge, Firefox (and Firefox ESR) and Opera; the last 3 versions of Safari |
| Memory | 4 GB RAM or more (6 GB recommended) on phones |

Older browsers may still open MPro, but offline mode and installing need the versions above.

## Phone and computer (r294)

Everything works in both. The phone app adds: the bottom tabs, the phone Overview with shortcuts, scanning with the
camera, taking and marking up photos, running timers that follow you around the app, and offline mode. Reporting
and setting things up (settings, roles, imports) are easier on a computer.

## Offline mode (r291)

- While you're online, the phone keeps the work orders **assigned to you or your teams** that are still open (plus
  ones finished in the last 3 days), soonest due first, up to 150. They're kept in the phone's storage, so they're
  still there after closing the app or restarting the phone.
- Offline you can open them and: change the status (including Done), answer procedures, comment (text), log time,
  start / pause / stop timers and mark parts as used. A banner says you're offline, and a cloud button at the top
  shows how many changes are waiting.
- When the connection is back, the changes are sent in the order you made them. Each one is sent with a key, so it's
  never applied twice even if the connection drops mid-send.
- If someone changed the same work order in the meantime, your change isn't forced over theirs: it shows in the sync
  panel (the cloud button) with **Keep mine** or **Keep theirs**.
- You can't switch organizations while offline or with changes waiting, and signing out keeps waiting changes on
  the phone until you sign in again.
- Not offline (yet): creating work orders, adding photos and files, and anything outside your saved work orders.

## Dark mode and dictation (r322, r325)

Pick Dark (or Match my device) from the account menu at the top right; it follows you to every device. To dictate
instead of typing, use the microphone on the phone's keyboard: every text box in MPro accepts it.
