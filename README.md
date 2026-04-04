# 💬 WebPrompter.app

WebPrompter is a lightweight, browser-based teleprompter designed for solo creators. It allows you to turn any iPad or tablet into a functional prompter while using your smartphone as a wireless remote control.

## Key Features

- Wireless Remote Control: Scan a QR code to sync your phone and control speed, font size, and scrolling.
- Zero Installation: Works entirely in the browser using PeerJS for real-time connectivity.
- Mirror Mode: Support for physical glass beam-splitters.
- Responsive UI: Optimized for iPad/Tablet displays and mobile remote interfaces.
- Privacy-First: Your scripts are processed locally and not stored on a server.

## How to Use

1. **Prepare your Script.** Open **WebPrompter.app** on your iPad, tablet or any browser.
2. **Paste & Launch.** Paste your Script and hit **Launch Prompter & Remote**.
3. **Sync Remote.** Scan the generated QR code with your smartphone.
4. **Record.** Place your tablet near the camera lens and control the flow from your hand.

⚠️ Communication between tablet and phone requires access to Internet.
Silent your devices but avoid airplane mode.

## Tech Stack

**Frontend:** HTML5, CSS3 (Flexbox/VH units for responsive layout)
**Connectivity:** PeerJS (WebRTC) for peer-to-peer remote control
**QR Generation:** QRCode.js
**Analytics:** Counter.dev (Privacy-friendly analytics)
# webprompterapp
