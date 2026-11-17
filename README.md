# Rookery (by Stinky Penguin) — launchpad dla sieci, które jeszcze nie działają

Strona: **https://rookery.stinkypenguin.xyz**

Sieci: **Zero** (LayerZero, mainnet 30.11) i **GIWA** (Upbit, testnet, mainnet TBA).
Waluta handlu: **ZRO**, wszystkie ceny pokazywane w **USD** (kurs ZRO z OKX, zapasowo Bybit, KuCoin, CoinGecko, odświeżany co minutę).
Opłata platformy: **0,5% od każdej transakcji** trafia do rezerwy **$臭企鹅 buy & burn**.

## Co działa

| Funkcja | Opis |
|---|---|
| Konta | rejestracja i logowanie emailem i hasłem (PBKDF2), sesja w ciasteczku HttpOnly na 30 dni |
| Depozyty ZRO | każdy użytkownik dostaje własny adres (ten sam na Ethereum, Base, Arbitrum, BNB Chain i Optimism). Wpłaty wykrywane automatycznie co minutę, gdy użytkownik ma otwartą stronę portfela, albo przyciskiem „Check for deposits” |
| Wypłaty | natychmiast z hot walleta na wybraną sieć. Limity 5 000 ZRO na wypłatę i 20 000 ZRO dziennie. Jeśli wysyłka się nie uda, saldo wraca od razu |
| Handel | krzywa bondingowa (1 mld podaży, 800 mln na krzywej, 200 mln na pulę mainnetu), kupno i sprzedaż dowolnej kwoty, szybkie kwoty, „⚡ Quick buy” jednym kliknięciem |
| Tworzenie tokena | zdjęcie z komputera, nazwa, ticker, opis, sieć (Zero/GIWA), para ZRO, socials (X, Telegram, www), limit kupna na start (% podaży przez X minut), podatki twórcy: marketing (ZRO do twórcy), burn tokena, nagrody w ZRO dla holderów (max 5% każdy, 10% łącznie), opcjonalny dev buy |
| Strona tokena | świece (TradingView Lightweight Charts) 1m/5m/15m/1h w USD, transakcje, holderzy, komentarze, opis, postęp krzywej, podatki, nagrody do odebrania |
| Trading | tabela wszystkich rynków (cena, 5m/1h/24h, MC, wolumen, holderzy, postęp) i strumień transakcji na żywo |
| Profil tradera | avatar, nazwa, bio, wartość portfela, wolumen, transakcje, stworzone tokeny |
| Docs | pełna dokumentacja z wykresem krzywej i podziałem opłat |
| Proofs | suma ZRO należnych użytkownikom, rezerwa pLAUNCH, adres hot walleta z linkami do eksploratorów, Merkle root sald |

## Portfel platformy (najważniejsze)

- Wszystkie adresy depozytowe i hot wallet pochodzą z **jednej frazy seed** (ścieżka `m/44'/60'/0'/0/i`).
  - `i = 0` to **hot wallet**: `0x2fc334dB3B68995Ca29Ba752d47B4d88c025990D`
  - `i = 1, 2, 3…` to adresy depozytowe kolejnych użytkowników.
- Po zaimportowaniu frazy do MetaMaska konto nr 1 to hot wallet, a kolejne konta to adresy depozytowe.
- Fraza leży w pliku `.master_mnemonic` na serwerze roboczym, a klucz rozszerzony jako sekret `MASTER_XPRV` w Cloudflare. **Zrób kopię frazy offline.** Bez niej nie odzyskasz depozytów.

### Żeby wypłaty działały
Zasil hot wallet ZRO i gazem na sieciach, na których chcesz wypłacać:
- Ethereum, Base, Arbitrum, Optimism: ETH,
- BNB Chain: BNB.

### Przenoszenie depozytów do hot walleta (sweep)
Depozyty zostają na adresach użytkowników. Żeby zasiliły hot wallet, trzeba je okresowo przenieść. Każdy adres depozytowy potrzebuje na to odrobiny gazu. Na razie robi się to ręcznie z MetaMaska (frazą). Automatyczny sweep to następny krok.

## Administracja

```bash
K=$(cat .admin_key)
U=https://rookery.stinkypenguin.xyz/api

# ręczne dopisanie ZRO użytkownikowi (np. wpłata z innej sieci)
curl -s -X POST $U/admin/credit -H 'content-type: application/json' -H 'x-pl: 1' \
  -d "{\"key\":\"$K\",\"user\":\"nazwa_lub_email\",\"amount\":\"10000000000000000000\",\"note\":\"manual\"}"

# publikacja Merkle root sald (raz dziennie)
curl -s -X POST "$U/admin/proof?key=$K" -H 'x-pl: 1'

# awaryjne wstrzymanie i wznowienie wypłat
curl -s -X POST "$U/admin/pause?key=$K&on=1" -H 'x-pl: 1'
curl -s -X POST "$U/admin/pause?key=$K&on=0" -H 'x-pl: 1'
```

Kwoty w wei: 1 ZRO = `1000000000000000000`.

## Migracja na mainnet
Opisana w Docs na stronie: snapshot sald, wdrożenie tokena (1 mld), mint 1:1 dla holderów, pula z rezerwy krzywej i 200 mln tokenów po ostatniej cenie, LP zablokowane.

## Przed dużym ruchem
1. Kopia frazy offline i przeniesienie jej do sejfu sprzętowego.
2. Automatyczny sweep depozytów do hot walleta i cold walleta.
3. Weryfikacja emaila i reset hasła (wymaga dostawcy poczty, np. Resend).
4. 2FA dla wypłat.
5. Licencja: kustodia i handel w UE to CASP/MiCA.

## Deploy
```bash
./deploy.sh                                         # rookery.stinkypenguin.xyz
PRELAUNCH_DOMAIN=launch.twojadomena.xyz ./deploy.sh
```
