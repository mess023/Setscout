# Setscout

Lokale web-app die de track-ID's uit DJ-sets haalt. Setscout knipt de mix in fragmenten en stuurt die langs een instelbare **keten** van herkenningsmethodes. Daarna toont hij per track de Van- en Tot-tijd op de seconde, en kun je de lijst nakijken, bewerken en exporteren naar txt, csv of json.

| Groep | Methodes |
|---|---|
| Cloud | Shazam, Shazam gepitcht (fragment ±% terugpitchen), AudD, AudioTag.info, AcoustID |
| Eigen collectie (index van je muziekmappen) | audfprint, Olaf, Panako, Dejavu, NeuralFP (NAFP) en PeakNetFP (neuraal, aparte container `setscout-nafp`) |
| Referentie-tracklists (vullen gaten) | trackid.dev (YouTube-ID in de bestandsnaam), 1001Tracklists (best effort) |
| Verrijking | MusicBrainz (album/jaar/ISRC), Essentia (BPM/key) |
| Experimenteel | Google "Zoek een nummer" via een Android-emulator (zie `docker/android/README.md`) |

**Van/Tot op de seconde.** Elke herkenning geeft een offset terug: de positie binnen het originele nummer. Begin = fragmentstart − offset, gecorrigeerd voor het tempo van de DJ. Setscout kiest daarvan het grootste cluster schattingen dat het eens is. Twijfelgevallen kleuren oranje.

## Lokaal draaien

Je hebt Node 18+ en ffmpeg op het PATH nodig.

```bash
npm install
npm run ui        # http://localhost:3847
npm test
```

Instellingen staan onder **Instellingen** in de app, per methode:
- aan/uit;
- sleutels en drempels;
- status ("Klaar", "Sleutel ontbreekt", "Niet geïnstalleerd", "Index leeg").

De volgorde van de keten pas je aan door te slepen.

Instellingen en API-sleutels staan in `data/settings.json`. De browser krijgt nooit een sleutel te zien.

De CLI van mix-id werkt nog steeds: `node cli.mjs mix.mp3`.

## Docker / TrueNAS SCALE

GitHub Actions bouwt de image bij elke push naar `main`: `ghcr.io/mess023/setscout:latest` (linux/amd64). De image bevat alle tools: ffmpeg, fpcalc, audfprint, Olaf, Panako, Essentia, adb en paplay.

**1. Datasets aanmaken** (Datasets → Add Dataset, preset **Apps**):

| Dataset (voorbeeld) | Mount in container | Rechten |
|---|---|---|
| `tank/apps/setscout` | `/data` (instellingen, sleutels, indexen) | lezen/schrijven |
| je muziekmap, bijv. `tank/music` | `/music` | alleen lezen |
| je mixen, bijv. `tank/djsets` | `/sets` | alleen lezen |
| `tank/djsets/tracklists` | `/exports` | lezen/schrijven |

**2. App installeren:**
1. Ga naar Apps → Discover Apps → ⋮ → **Install via YAML**.
2. Name: `setscout`.
3. Plak `docker-compose.yml`.
4. Pas de `/mnt/tank/...`-paden aan je datasets aan.
5. Zet `SETSCOUT_PASSWORD` op een eigen wachtwoord. **Verplicht op je LAN**: de app kan bestanden in de gemounte mappen lezen.
6. Save.

De container draait als `user: "568:568"` (de TrueNAS-gebruiker *apps*). Zijn je datasets van een andere gebruiker, pas dat dan aan, of haal de regel weg om als uid 1000 te draaien.

**3. Openen:** `http://<truenas-ip>:3847`. Log in met een willekeurige gebruikersnaam en het wachtwoord. Daarna in de app:
1. Ga naar Instellingen → Collectie → `/music` toevoegen → **Index bijwerken**.
2. Zet de methodes aan en zet ze in de gewenste volgorde.

Exporteren gaat via Instellingen → Export → **Op de server**: de bestanden komen dan in `/exports`. De opslaan-dialoog van de browser werkt alleen via HTTPS of localhost.

| Env | Betekenis |
|---|---|
| `SETSCOUT_PASSWORD` | HTTP Basic-wachtwoord (gebruikersnaam maakt niet uit). Een `$` schrijf je in compose als `$$`; de log toont bij het starten de lengte ter controle |
| `SETSCOUT_ROOTS` | mappen die de file browser mag tonen (standaard `/sets:/music:/exports`) |
| `PORT`, `HOST` | luisteradres (standaard 3847, 0.0.0.0 in de image) |

Buiten je LAN alleen achter een reverse proxy met HTTPS.

**Optioneel: neurale fingerprinting** (NeuralFP/PeakNetFP). Voeg de service `setscout-nafp` uit `docker-compose.yml` toe (zelfde `/data`- en `/music`-paden als setscout, geen poort nodig). Daarna in Setscout: Instellingen → *NeuralFP (NAFP)* en/of *PeakNetFP* aanzetten → Collectie → **Index bijwerken**. Draait op CPU; indexeren kost enkele seconden per track.

**Optioneel: de Android-emulator** voor Google "Zoek een nummer". Die heeft `/dev/kvm` nodig en zit niet in CI. Bouwen en inloggen: zie [`docker/android/README.md`](docker/android/README.md).

## Bronvermelding en licenties

Setscout is gebaseerd op [mix-id](https://github.com/skip5this/mix-id) van Scott Bell (MIT). Setscout zelf valt onder de MIT-licentie, zie `LICENSE`.

Gebruikte software; die zit **niet** in deze repo, maar wordt in de Docker-image geïnstalleerd of via npm opgehaald:

| Software | Licentie | Bron |
|---|---|---|
| shazam-api (npm) | GPL-2.0 | https://www.npmjs.com/package/shazam-api |
| audfprint | MIT | https://github.com/dpwe/audfprint |
| Dejavu (bcollazo-fork, SQLite) | MIT | https://github.com/bcollazo/dejavu |
| yt-dlp / Deno | Unlicense / MIT | https://github.com/yt-dlp/yt-dlp · https://github.com/denoland/deno |
| Olaf | AGPL-3.0 | https://github.com/JorenSix/Olaf |
| Panako | AGPL-3.0 | https://github.com/JorenSix/Panako |
| Essentia | AGPL-3.0 | https://github.com/MTG/essentia |
| PeakNetFP / NeuralFP-code (worker-image) | CC BY-NC-SA 4.0 (niet-commercieel) | https://github.com/guillemcortes/peaknetfp |
| PeakNetFP/NeuralFP-checkpoints | MIT | https://doi.org/10.5281/zenodo.15782389 |
| TensorFlow / FAISS (worker-image) | Apache-2.0 / MIT | https://www.tensorflow.org · https://github.com/facebookresearch/faiss |
| Chromaprint / fpcalc | LGPL-2.1 | https://github.com/acoustid/chromaprint |
| ffmpeg | LGPL/GPL | https://ffmpeg.org |
| docker-android (optioneel) | MIT | https://github.com/HQarroum/docker-android |

Herkenning via Shazam, AudD, AudioTag, AcoustID, trackid.dev, 1001Tracklists en Google gebruikt diensten van derden. Hun gebruiksvoorwaarden gelden, en 1001Tracklists heeft geen officiële API.
