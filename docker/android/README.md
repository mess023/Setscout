# Android-emulator voor "Google Zoek een nummer" (experimenteel)

Setscout opent in deze emulator "Zoek een nummer" in de Google-app. Het speelt het fragment af in een virtuele microfoon (PulseAudio null-sink) en leest de titel van het scherm (uiautomator).

- **Geen officiële API.** Elke update van de Google-app kan het breken.
- **Accountrisico.** Het Google-account kan gemarkeerd worden voor geautomatiseerd gebruik. Gebruik een apart account, niet je hoofdaccount.

## Nodig

| Wat | Waarom |
|---|---|
| Host met `/dev/kvm` (TrueNAS op bare metal, of nested virtualisation in een VM) | Zonder KVM is de emulator onbruikbaar traag |
| ±12 GB schijf voor de images, 4 GB RAM voor de emulator | Android-systeemimage met Play Store |
| Een apart Google-account | Inloggen doe je zelf, één keer |
| [scrcpy](https://github.com/Genymobile/scrcpy) op je pc (of een ander ADB-scherm) | Om het scherm van de emulator te zien bij het inloggen |

## Stappen

1. **Base-image bouwen.** Dit is HQarroum/docker-android met de Play Store:
   ```
   docker build -t setscout-android-base --build-arg IMG_TYPE=google_apis_playstore --build-arg API_LEVEL=33 https://github.com/HQarroum/docker-android.git
   ```
2. **ADB-sleutel delen.** Play Store-images accepteren alleen de ADB-sleutel uit die repo (`keys/adbkey`). Kopieer dat bestand naar je Setscout-datamap (`/data/adbkey` in de container). Zet daarna bij de service `setscout` de environment-variabele `ADB_VENDOR_KEYS: /data/adbkey`.
3. **Starten:** `docker compose --profile google up -d`. Op TrueNAS doe je dit via **Install via YAML**: plak de complete `docker-compose.yml`, met de `android`-service erin.
4. **Eenmalig inloggen (dat doe je zelf):**
   1. Op je pc: `adb connect <nas-ip>:5555`, daarna `scrcpy -s <nas-ip>:5555`.
   2. In het emulatorscherm: **Instellingen → Wachtwoorden en accounts → Account toevoegen → Google**. Log in met het aparte account.
   3. Open de **Google-app** en tik op het **microfoontje → Zoek een nummer**. Geef toestemming voor de microfoon.
   4. Sluit scrcpy. De login blijft bewaard in het volume van de `android`-service.
5. **In Setscout:** ga naar Instellingen en zet **Google "Zoek een nummer"** aan. De status moet "Klaar · emulator verbonden" zijn. Zet de methode achteraan in de keten.
6. **Afstellen.** Vindt hij niets, dan toont de scanlog één keer de zichtbare teksten met hun resource-id. Pas daarmee in de instellingen *Titel-id* en *Artiest-id* aan. Opent het luisterscherm niet, pas dan *Intent* aan.

**Beveiliging:** poort 5555 (ADB) geeft volledige controle over de emulator. Open hem alleen tijdens het inloggen, of alleen op je LAN. Setscout zelf praat met de emulator via het interne compose-netwerk (`android:5555`, `android:4713`).
