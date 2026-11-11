# Controfase

Cancellazione attiva di un ronzio a bassa frequenza (es. 100 Hz) nel punto in cui
dormi: l'app genera un tono alla stessa frequenza e lo mette in **controfase**,
misurando il risultato con il microfono.

Pagina: https://adrianss31.github.io/low-freq-hunter/controfase/
(su Mac: Safari → File → **Aggiungi al Dock** per averla come app)

## Come funziona

Tutto gira in un unico `AudioWorklet`, quindi tono e microfono condividono lo
stesso clock campione per campione.

- **Generatore**: `y = A·cos(θ + φ)` con cambi di ampiezza/fase smussati (~50 ms).
- **Misura**: demodulatore lock-in (finestra di Hann, blocchi da 0,1 s) che dà il
  fasore `M` della componente alla frequenza del tono al microfono.
- **Stima frequenza** (uscita spenta): dalla rotazione del fasore del disturbo.
- **Calibrazione**: `S = (M_tono − M_disturbo) / W_prova` (percorso altoparlante →
  microfono), con compensazione della rotazione del disturbo fra le misure.
- **Automatico**: `W ← W − μ·M/S`, converge a `W = −D/S`. Insegue la frequenza
  dalla rotazione di `W` (±0,9 Hz). Si ferma da solo se il livello sale.

Il microfono è aperto con `echoCancellation`, `noiseSuppression` e
`autoGainControl` disattivati (altrimenti il browser cancellerebbe il nostro tono).

## Prova senza microfono

`index.html?sim=1` simula una stanza (disturbo a 100,037 Hz, percorso −4,4 dB,
31 ms di ritardo): utile per vedere l'algoritmo all'opera.

## Limiti fisici

- Zona di silenzio di ~30–40 cm attorno al microfono; altrove il tono può
  aumentare il 100 Hz.
- Solo la frequenza impostata (non le armoniche).
- Non agisce sulle vibrazioni che arrivano per via strutturale (letto, pavimento).
