# Controfase

Cancellazione attiva dei ronzi a bassa frequenza (es. 64 e 100 Hz) nel punto in cui
dormi: l'app trova i toni nello spettro, genera per ciascuno un tono uguale e lo mette
in **controfase**, verificando il risultato con il microfono.

Pagina: https://adrianss31.github.io/low-freq-hunter/controfase/
(Chrome → “Installa pagina come app”, oppure Safari → File → **Aggiungi al Dock**.
Con Chrome si può fissare anche l'altoparlante.)

## Uso

Microfono dove appoggi la testa, poi **Trova e cancella**:

1. ascolta lo spettro 20–500 Hz e trova i picchi che spiccano sul fondo;
2. aggancia la frequenza esatta di ognuno (fino a 3 automaticamente, 6 a mano);
3. calibra il percorso altoparlante → microfono per ogni tono;
4. avvia la cancellazione: passi grandi all'inizio, sempre più piccoli, poi **si ferma**.

Quando tutti i toni sono stabili, se scegli “spegni il microfono e ricontrolla”, il
microfono si chiude e si riapre ogni tanto (intervallo automatico dalla deriva misurata
della sorgente, o fisso) per verificare e correggere.

## Come funziona

Tutto il segnale passa per un unico `AudioWorklet`: toni e microfono condividono il
clock campione per campione.

- **Per ogni tono**: oscillatore ricorsivo, demodulatore lock-in (finestra di Hann,
  blocchi da 0,25 s) e due sonde a ±8 Hz che misurano il rumore nella stessa banda.
- **Aggancio di fase (PLL)** sul disturbo stimato `D = M − S·W`: tiene ferma la fase del
  ronzio rispetto al nostro oscillatore anche se la sorgente deriva; guadagni adattati al
  rapporto segnale/rumore.
- **Controllo**: `W ← W − K·M/S` con K che parte da 0,3 e si riduce del 5% a ogni blocco
  finché il residuo migliora; riparte a 0,3 solo se il residuo sale di oltre 6 dB rispetto
  al minimo (o sopra −30 dB rispetto al ronzio originale). Quando K è al minimo e il residuo
  è fermo, il tono si **blocca** (stato “stabile”).
- **Percorso S**: misurato in calibrazione (spento / tono di prova / spento, con
  compensazione della rotazione) e corretto in linea dal guadagno osservato del ciclo,
  entro ±60° e ±6 dB.
- **Protezioni**: riaggancio automatico se il ronzio cambia; se il livello sale di 6 dB
  sopra l'originale per 8 s il tono si spegne e si ricalibra da solo (max 3 volte in 10 min).
- **Dispositivi**: microfono (e altoparlante, dove il browser lo consente) fissati per
  `deviceId`; se il microfono si scollega, si riattiva da solo quando torna.

## Prova senza microfono

`index.html?sim=1` simula una stanza con due ronzi (100,037 Hz e 64,21 Hz) che derivano
in frequenza, rumore, percorso −4,4 dB con 31 ms di ritardo e piccole variazioni di
latenza a ogni riapertura del microfono.

## Limiti fisici

- Zona di silenzio di ~30–40 cm attorno al microfono; altrove i toni possono aumentare il ronzio.
- Con il microfono spento l'app non sa se il ronzio è cambiato: se la sorgente si ferma,
  il tono resta acceso da solo fino al ricontrollo successivo, che lo spegne.
- Non agisce sulle vibrazioni che arrivano per via strutturale (letto, pavimento).
