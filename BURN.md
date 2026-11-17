# $臭企鹅 buy & burn — jak działa i jak uruchomić

## Przepływ (w pełni automatyczny)
1. **Rezerwa**: 0,5% z każdej transakcji na Rookery (w ZRO) zwiększa licznik `plaunch_burn` w księdze.
2. **Start spalania**: co 24 h (domyślnie), jeśli rezerwa ma co najmniej 20 ZRO, system bierze do 5 000 ZRO i zakłada zadanie spalania. Licznik rezerwy maleje dokładnie o tę kwotę.
3. **Przelew do portfela spalania**: hot wallet wysyła ZRO na Arbitrum do portfela spalania `0x56a5a970160C24da39500af1C933e3Eed08c83A1`. Jeśli portfel spalania nie ma gazu, hot wallet dosyła mu 0,0006 ETH.
4. **Most**: portfel spalania przez Relay zamienia ZRO z Arbitrum na ETH na Robinhood Chain (approve i deposit, potem czekanie na status `success`). Gdy Relay zwróci środki, krok ponawia się automatycznie.
5. **Wykup i spalenie**: na Robinhood Chain portfel spalania kupuje $臭企鹅 na Uniswap V3 (pula WETH/$臭企鹅 z największą płynnością, wycena z QuoterV2, poślizg maks. 3%). Odbiorcą jest od razu `0x000000000000000000000000000000000000dEaD`, więc tokeny są kupione i spalone w jednej transakcji. 0,0003 ETH zostaje na gaz.
6. **Publikacja**: każdy etap z linkami do transakcji jest na https://rookery.stinkypenguin.xyz/#/proofs/burns.

Zadanie wykonuje się krokami co minutę (zadanie cykliczne Workera), z blokadą przed podwójnym wykonaniem. Po 15 nieudanych próbach dostaje status `failed`; jeśli ZRO nie zdążyło wyjść z hot walleta, wraca do rezerwy.

## Uruchomienie po wylistowaniu $臭企鹅 na Robinhood Chain
Warunki: token jest wdrożony na Robinhood Chain i ma pulę **WETH/$臭企鹅 na Uniswap V3** z płynnością (factory `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`).

Jedna komenda:
```bash
K=$(cat .admin_key)
curl -s -X POST "https://rookery.stinkypenguin.xyz/api/admin/burn/config?key=$K" \
  -H 'x-pl: 1' -H 'content-type: application/json' \
  -d '{"token":"0xADRES_TOKENA_NA_ROBINHOOD"}'
```
Od tej chwili auto-spalanie startuje przy następnym ticku (do minuty) i zużywa całą zebraną rezerwę (do 5 000 ZRO na raz).

Opcje (w tym samym endpoincie): `auto` (true/false), `intervalH`, `minZro`, `maxZro`, `slippageBps`, `source` (`arbitrum`, `base`, `ethereum`, `optimism`, `bsc`).

Ręczne spalenie teraz: `POST /api/admin/burn/run?key=…`.

## Co musi być zasilone
- **Hot wallet** `0x2fc334dB3B68995Ca29Ba752d47B4d88c025990D` na **Arbitrum**: ZRO w wysokości rezerwy plus odrobina ETH na gaz.
- Gaz na Robinhood Chain nie jest potrzebny, bo pochodzi z ETH uzyskanego z mostu.

## Sprawdzone na mainnecie (tylko odczyt, 13.11)
- Uniswap V3 na Robinhood Chain: wybór puli i wycena działają (test na parze WETH/USDG: 0,01 ETH → 19,48 USDG).
- Relay: 100 ZRO z Arbitrum → 0,0814 ETH na Robinhood Chain (≈ $158,56), kroki approve i deposit.
