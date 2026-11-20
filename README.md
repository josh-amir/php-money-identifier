# Accessible Philippine Money Identifier

A strictly high-contrast, audio-first PWA for identifying Philippine coins and banknotes with an ONNX model. It runs in supported browsers and can remain available offline after installation.

## Model and class order

The app reads `model/labels.json` and `model/speech.json` directly. The confirmed label order is:

`bill_100, bill_1000, bill_200, bill_50, bill_500, coin_005, coin_025, coin_1, coin_10, coin_5, 20`

Keep `model/best.onnx`, `model/labels.json`, and `model/speech.json` in the model folder.

## Run locally with VS Code Live Server

1. Open this project folder in VS Code.
2. Install the **Live Server** extension, if it is not already installed.
3. Right-click `index.html` and select **Open with Live Server**.
4. Open the displayed `http://127.0.0.1:5500/` address in Chrome or Edge.
5. Allow camera access, tap **TAP ANYWHERE TO START MONEY IDENTIFIER**, then use **SCAN MONEY** or press Spacebar.

Camera and Web Serial features work on localhost or HTTPS. iOS Safari does not support Web Serial.

## Deploy

### GitHub Pages

1. Push this project to a GitHub repository.
2. Open **Settings > Pages**.
3. Select the repository branch and `/ (root)` folder, then save.
4. Open the HTTPS Pages URL on a phone and allow camera access.

### Netlify

1. Create a new Netlify project from the repository or drag the project folder into Netlify Drop.
2. Deploy the folder at the repository root.
3. Open the generated HTTPS URL on a phone.

After loading once with internet access, use the installed PWA menu and the Service Worker cache for offline use. No backend server is required.

## Phone installation

- **Android Chrome:** open the HTTPS site, open the browser menu, and choose **Install app** or **Add to Home screen**.
- **iPhone/iPad Safari:** open the HTTPS site, tap Share, then choose **Add to Home Screen**.

For reliable WASM loading, install from a supported modern browser and keep the app origin consistent.

## Arduino wiring

Use an Arduino Uno, Nano, or compatible board:

| Component | Arduino pin |
|---|---:|
| Scan button, one side to GND | 2 |
| Repeat button, one side to GND | 3 |
| Buzzer positive | 8 |
| Buzzer negative | GND |

Both push buttons use `INPUT_PULLUP`, so connect the other side of each button directly to GND. Use a suitable piezo buzzer or a transistor-driving circuit for higher-current buzzers.

## Arduino setup

1. Open `arduino/money_identifier_controller.ino` in Arduino IDE.
2. Select the board and USB port.
3. Upload the sketch.
4. Open the PWA over HTTPS or localhost.
5. Choose **Connect Arduino** and select the Arduino serial port.
6. The web app communicates at 9600 baud.

Scan pin 2 sends `SCAN\n`. Repeat pin 3 sends `REPEAT\n`. The web app sends `SUCCESS\n` or `FAIL\n`; pin 8 produces the corresponding tones.
