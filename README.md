# Low-Freq Hunter

PWA per rilevare e **documentare** rumori a bassa frequenza (tipicamente 50/100 Hz:
ronzii di rete elettrica, trasformatori, impianti) con il microfono del telefono.
Pensata per registrare disturbi notturni prolungati e produrne prova oggettiva:
quando iniziano, quanto durano, con che intensità.

## Funzionamento

- **Live** — spettro in tempo reale + waterfall scorrevole per individuare la
  frequenza del rumore e tarare le soglie. Sonificazione "Geiger" e confronto
  A/B (sorgente accesa/spenta) per la caccia manuale.
- **Notte** — log continuo per tutta la notte: livelli per banda (1 campione/s),
  eventi sopra soglia con isteresi e durate minime ON/OFF, spettrogramma
  persistito, marker manuali ("lo sento adesso", anche dallo schermo nero),
  clip audio opzionali sugli eventi. Wake lock + schermata nera per dormire.
- **Riepilogo** — timeline, spettrogramma, tabella eventi, marker, clip.
  Export: **report PNG** autocontenuto, CSV eventi, CSV campioni, JSON.

Scelte deliberate: **soglie assolute in dBFS** (niente calibrazione o baseline
adattiva), bande completamente configurabili: aggiungine quante ne servono
(fino a 8), ognuna con centro, larghezza e soglia propri. I buchi di
monitoraggio (>5 s senza analisi) vengono registrati come **gap**: per un dato
che vuole essere una prova conta anche sapere quando NON si stava misurando.

I livelli sono dBFS relativi al fondo scala del microfono, **non** dB SPL
calibrati: misura indicativa, non fonometria certificata.

## Sviluppo locale

```sh
python3 serve.py   # http://localhost:8765
```

Il microfono richiede HTTPS oppure localhost.

## Deploy su GitHub Pages

1. Crea un repository su GitHub e pusha questa cartella (`main`).
2. Settings → Pages → Source: *Deploy from a branch* → `main` / root.
3. Apri `https://<utente>.github.io/<repo>/` dal telefono e usa
   "Aggiungi a schermata Home" per installarla come app.

A ogni deploy alza `CACHE_VERSION` in `sw.js` per invalidare la cache offline.

## Note tecniche

- Web Audio `AnalyserNode` con FFT fino a 32768 punti a sample rate nativo
  (≈1.5 Hz/bin a 48 kHz). AGC, echo cancellation e noise suppression disattivati.
- Loop notturno su `setInterval` (non `requestAnimationFrame`) + wake lock.
- Dati in IndexedDB con richiesta di storage persistente; le sessioni
  interrotte (crash/batteria) vengono chiuse al riavvio usando l'ultimo
  campione salvato.
