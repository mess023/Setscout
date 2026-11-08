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

## Stappen (TrueNAS)

TrueNAS bewaart en start de compose-YAML zelf. Daarom werkt `docker compose --profile google …` in de shell niet (er staat geen compose-bestand in je map), en kan TrueNAS niets bouwen uit `build: ./docker/android`. De twee images bouw je dus één keer in de **TrueNAS-shell**, en in de YAML staat alleen `image:`.

1. **TrueNAS-shell: base-image bouwen** (HQarroum/docker-android met de Play Store):
   ```
   docker build -t setscout-android-base --build-arg IMG_TYPE=google_apis_playstore --build-arg API_LEVEL=33 https://github.com/HQarroum/docker-android.git
   ```
2. **TrueNAS-shell: Setscout-laag bouwen** (virtuele microfoon). Deze stap is nodig, anders bestaat `setscout-android:latest` niet:
   ```
   cd /mnt/Apps/Setscout && curl -fsSL https://github.com/mess023/Setscout/archive/refs/heads/main.tar.gz | tar -xz
   docker build -t setscout-android:latest /mnt/Apps/Setscout/Setscout-main/docker/android
   ```
3. **TrueNAS-shell: ADB-sleutel en thuismap.** Play Store-images accepteren alleen de ADB-sleutel uit die repo (`keys/adbkey`). Zet hem als `adbkey` in je Setscout-datamap en geef hem aan de apps-gebruiker:
   ```
   chown 568:568 /mnt/Apps/Setscout/adbkey && chmod 600 /mnt/Apps/Setscout/adbkey
   mkdir -p /mnt/Apps/Setscout/home && chown 568:568 /mnt/Apps/Setscout/home
   ```
4. **TrueNAS-UI: YAML.** Bij de service `android`: **geen** `profiles:` en **geen** `build:`, wel `image: setscout-android:latest` + `pull_policy: never`. Bij `setscout`: `ADB_VENDOR_KEYS: /data/adbkey`. Save, en wacht 1–3 minuten tot de emulator is opgestart (Logs van de container `android`).
5. **Eenmalig inloggen (dat doe je zelf):**
   1. Op je pc: de emulator accepteert alleen dezelfde repo-sleutel, dus ook je pc-adb moet die gebruiken. Kopieer `adbkey` naar je pc (bijv. naar de scrcpy-map) en voer in die map uit:
      `set ADB_VENDOR_KEYS=%CD%\adbkey` → `adb kill-server` → `adb connect <nas-ip>:5555` → `scrcpy -s <nas-ip>:5555`.
   2. In het emulatorscherm: **Instellingen → Wachtwoorden en accounts → Account toevoegen → Google**. Log in met het aparte account.
   3. Open de **Google-app** en tik op het **microfoontje → Zoek een nummer**. Geef toestemming voor de microfoon.
   4. Sluit scrcpy. De login blijft bewaard in het volume van de `android`-service.
6. **In Setscout:** ga naar Instellingen en zet **Google "Zoek een nummer"** aan. De status moet "Klaar · emulator verbonden" zijn. Zet de methode achteraan in de keten.
7. **Afstellen.** Vindt hij niets, dan toont de scanlog één keer de zichtbare teksten met hun resource-id. Pas daarmee in de instellingen *Titel-id* en *Artiest-id* aan. Opent het luisterscherm niet, pas dan *Intent* aan.

**Beveiliging:** poort 5555 (ADB) geeft volledige controle over de emulator. Open hem alleen tijdens het inloggen, of alleen op je LAN. Setscout zelf praat met de emulator via het interne compose-netwerk (`android:5555`, `android:4713`).

## Problemen

| Symptoom in de log van `android` | Oplossing |
|---|---|
| `Segmentation fault … emulator` (vaak bij Play Store/Chrome) | Opgelost in het startscript (Vulkan uit). Bouw `setscout-android:latest` opnieuw (stap 2) |
| `Daemon startup failed` (pulseaudio) in een lus | Opgelost: het startscript ruimt oude PulseAudio-bestanden op. Opnieuw bouwen (stap 2) |
| `Could not init 'pa' audio driver` | De virtuele microfoon werkt dan niet. Het startscript start de emulator daarom in venstermodus op een virtueel scherm (Xvfb), want alleen die variant heeft PulseAudio. Komt de regel toch terug: controleer dat `EMULATOR_WINDOW` **niet** op `none` staat |
| `cannot get x11 display info` + `Segmentation fault` kort na de start | Er was geen (virtueel) scherm. Opgelost met Xvfb; opnieuw bouwen (stap 2) |
| `Running multiple emulators with the same AVD` | Oude lock-bestanden na een crash. Het startscript ruimt die nu op; opnieuw bouwen (stap 2) |
| Emulator start niet meer na de update | Zet bij `android` tijdelijk `EMULATOR_WINDOW: none` (headless, **zonder microfoon**) en stuur de log |
