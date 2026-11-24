# Extrai da aba "Base" da planilha de programação a situação de cada pedido e grava um CSV (pedido;linhas;situacoes).
# Somente leitura da planilha. Uso:
#   python -I scripts/extrair-situacao-planilha.py "C:/caminho/Programação de Produção 2026 Novembro.xlsx" [saida.csv]
import csv, sys
from collections import defaultdict

import openpyxl

sys.stdout.reconfigure(encoding="utf-8")
if len(sys.argv) < 2:
    sys.exit("Informe o caminho da planilha (.xlsx).")
origem = sys.argv[1]
saida = sys.argv[2] if len(sys.argv) > 2 else "data/situacao-planilha.csv"

wb = openpyxl.load_workbook(origem, read_only=True, data_only=True)
ws = wb["Base"]
linhas = ws.iter_rows(values_only=True)
cab = None
for i, r in enumerate(linhas):
    if r and "PEDIDO" in r and any(isinstance(c, str) and c.strip().upper().startswith("SITUA") for c in r):
        cab = r
        break
if cab is None:
    sys.exit("Não achei o cabeçalho (PEDIDO / SITUAÇÃO) na aba Base.")
ip = cab.index("PEDIDO")
isit = next(i for i, c in enumerate(cab) if isinstance(c, str) and c.strip().upper().startswith("SITUA"))

situacoes = defaultdict(list)
for r in linhas:
    if not r or ip >= len(r) or r[ip] in (None, ""):
        continue
    try:
        numero = int(float(r[ip]))
    except (TypeError, ValueError):
        continue
    sit = (str(r[isit]).strip().lower() if isit < len(r) and r[isit] not in (None, "") else "(vazio)")
    situacoes[numero].append(sit)

with open(saida, "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f, delimiter=";")
    w.writerow(["pedido", "linhas", "situacoes"])
    for numero in sorted(situacoes):
        s = situacoes[numero]
        w.writerow([numero, len(s), "|".join(sorted(set(s)))])
print(f"{len(situacoes)} pedidos gravados em {saida}")
