/*
  LOLIN-S2-MINI two-port adaptive switch interface
  GPIO 1 = switch port 1
  GPIO 2 = switch port 2
  Each input is wired between its GPIO and GND.

  Serial configuration protocol at 115200 baud:
    GET              -> CFG,<usage1>,<mode1>,<usage2>,<mode2>
    SET,<port>,<usage>,<mode> -> OK,<port>,<usage>,<mode>
  mode 1 = press once per switch activation
  mode 2 = hold the key while the switch is held
  Settings are saved in ESP32 Preferences (nonvolatile).
*/

#include <USB.h>
#include <USBHIDKeyboard.h>
#include <Preferences.h>

#define SWITCH_1_PIN 1
#define SWITCH_2_PIN 2

USBHIDKeyboard Keyboard;
Preferences preferences;

struct SwitchConfig {
  uint8_t usage;
  uint8_t mode;
};

SwitchConfig config[2] = {
  { 0x2C, 1 },
  { 0x28, 1 }
};

struct SwitchState {
  bool raw;
  bool stable;
  unsigned long changedAt;
};

SwitchState switches[2] = {
  { true, true, 0 },
  { true, true, 0 }
};

const uint8_t switchPins[2] = { SWITCH_1_PIN, SWITCH_2_PIN };
const unsigned long debounceMs = 25;

bool validUsage(uint8_t usage) {
  return (usage >= 4 && usage <= 101) || (usage >= 224 && usage <= 231);
}

void tapKey(uint8_t usage) {
  Keyboard.pressRaw(usage);
  delay(12);
  Keyboard.releaseRaw(usage);
}

void switchPressed(uint8_t index) {
  if (config[index].mode == 1) {
    tapKey(config[index].usage);
  } else {
    Keyboard.pressRaw(config[index].usage);
  }
}

void switchReleased(uint8_t index) {
  if (config[index].mode == 2) {
    Keyboard.releaseRaw(config[index].usage);
  }
}

void printConfig() {
  Serial.printf("CFG,%u,%u,%u,%u\n",
    config[0].usage, config[0].mode,
    config[1].usage, config[1].mode);
}

void handleCommand(String line) {
  line.trim();
  if (line == "GET") {
    printConfig();
    return;
  }

  if (line.startsWith("SET,")) {
    int port = 0, usage = 0, mode = 0;
    if (sscanf(line.c_str(), "SET,%d,%d,%d", &port, &usage, &mode) != 3 ||
        port < 1 || port > 2 || usage < 0 || usage > 255 ||
        !validUsage((uint8_t)usage) || (mode != 1 && mode != 2)) {
      Serial.println("ERR,INVALID");
      return;
    }

    uint8_t index = (uint8_t)(port - 1);

    // Release the previous held key before changing a live assignment.
    if (switches[index].stable && config[index].mode == 2) {
      Keyboard.releaseRaw(config[index].usage);
    }

    config[index].usage = (uint8_t)usage;
    config[index].mode = (uint8_t)mode;

    preferences.putUChar(index == 0 ? "key1" : "key2", config[index].usage);
    preferences.putUChar(index == 0 ? "mode1" : "mode2", config[index].mode);

    Serial.printf("OK,%d,%u,%u\n", port, config[index].usage, config[index].mode);
    return;
  }

  if (line == "HELP") {
    Serial.println("COMMANDS: GET; SET,<port 1-2>,<HID usage>,<mode 1-2>");
    return;
  }

  Serial.println("ERR,UNKNOWN_COMMAND");
}

void setup() {
  pinMode(SWITCH_1_PIN, INPUT_PULLUP);
  pinMode(SWITCH_2_PIN, INPUT_PULLUP);

  Serial.begin(115200);
  preferences.begin("switchcfg", false);

  config[0].usage = preferences.getUChar("key1", 0x2C);
  config[0].mode = preferences.getUChar("mode1", 1);
  config[1].usage = preferences.getUChar("key2", 0x28);
  config[1].mode = preferences.getUChar("mode2", 1);

  for (uint8_t i = 0; i < 2; i++) {
    if (!validUsage(config[i].usage)) config[i].usage = (i == 0) ? 0x2C : 0x28;
    if (config[i].mode != 1 && config[i].mode != 2) config[i].mode = 1;
  }

  USB.begin();
  Keyboard.begin();

  for (uint8_t i = 0; i < 2; i++) {
    bool pressed = digitalRead(switchPins[i]) == LOW;
    switches[i].raw = !pressed;
    switches[i].stable = !pressed;
    switches[i].changedAt = millis();
    if (pressed && config[i].mode == 2) {
      Keyboard.pressRaw(config[i].usage);
    } else if (pressed && config[i].mode == 1) {
      switchPressed(i);
    }
  }
}

void loop() {
  // Receive newline-terminated configuration commands over USB CDC serial.
  static String command;
  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch == '\n' || ch == '\r') {
      if (command.length()) {
        handleCommand(command);
        command = "";
      }
    } else if (command.length() < 80) {
      command += ch;
    } else {
      command = "";
      Serial.println("ERR,COMMAND_TOO_LONG");
    }
  }

  // Debounced switch handling.
  unsigned long now = millis();
  for (uint8_t i = 0; i < 2; i++) {
    bool releasedLevel = digitalRead(switchPins[i]) == HIGH;

    if (releasedLevel != switches[i].raw) {
      switches[i].raw = releasedLevel;
      switches[i].changedAt = now;
    }

    if ((now - switches[i].changedAt) >= debounceMs &&
        switches[i].stable != switches[i].raw) {
      switches[i].stable = switches[i].raw;

      if (!switches[i].stable) {
        switchPressed(i);
      } else {
        switchReleased(i);
      }
    }
  }
}
