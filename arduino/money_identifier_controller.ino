const int PIN_SCAN_BTN = 2;
const int PIN_REPEAT_BTN = 3;
const int PIN_BUZZER = 8;

unsigned long lastScanPress = 0;
unsigned long lastRepeatPress = 0;
const unsigned long DEBOUNCE_MS = 250;

void setup() {
  Serial.begin(9600);
  pinMode(PIN_SCAN_BTN, INPUT_PULLUP);
  pinMode(PIN_REPEAT_BTN, INPUT_PULLUP);
  pinMode(PIN_BUZZER, OUTPUT);

  // Startup chime
  tone(PIN_BUZZER, 660, 100);
  delay(120);
  tone(PIN_BUZZER, 880, 120);
}

void loop() {
  unsigned long now = millis();

  if (digitalRead(PIN_SCAN_BTN) == LOW && (now - lastScanPress > DEBOUNCE_MS)) {
    lastScanPress = now;
    tone(PIN_BUZZER, 520, 80);
    Serial.println("SCAN");
  }

  if (digitalRead(PIN_REPEAT_BTN) == LOW && (now - lastRepeatPress > DEBOUNCE_MS)) {
    lastRepeatPress = now;
    tone(PIN_BUZZER, 440, 80);
    Serial.println("REPEAT");
  }

  if (Serial.available() > 0) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();

    if (cmd == "SUCCESS") {
      tone(PIN_BUZZER, 587, 110);
      delay(130);
      tone(PIN_BUZZER, 880, 180);
    } else if (cmd == "FAIL") {
      tone(PIN_BUZZER, 220, 280);
    }
  }
}