import json
import re
from pathlib import Path

import openpyxl
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter


BANK_CONFIGS = [
    {
        "key": "full",
        "label": "????",
        "input": Path(r"C:\Users\14274\Downloads\??????_????.xlsx"),
        "id_offset": 200000,
        "expected": 786,
    },
    {
        "key": "core",
        "label": "??????",
        "input": Path(r"C:\Users\14274\Downloads\??????_???????.xlsx"),
        "id_offset": 300000,
        "expected": 154,
    },
]

OUTPUT_JS = Path(__file__).with_name("data.js")
TEMPLATE_XLSX = Path(__file__).with_name("??????.xlsx")

QUESTION_TYPES = ["??", "??", "??"]
OPTION_LETTERS = list("ABCDEF")


def clean(value):
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def split_path(value):
    text = clean(value)
    if not text:
        return ["????"]
    return [p.strip() for p in re.split(r"[/?>?\\|]+", text) if p.strip()] or ["????"]


def split_tags(value):
    text = clean(value)
    if not text:
        return []
    return [p.strip() for p in re.split(r"[?,?;/?|]+", text) if p.strip()]


def normalize_type(value):
    text = clean(value)
    if "??" in text:
        return "??"
    if "??" in text or "???" in text:
        return "??"
    if "??" in text or text:
        return "??"
    return ""


def strip_option_prefix(value, letter):
    text = clean(value)
    if not text:
        return ""
    return re.sub(rf"^{letter}\s*[\.??:?]\s*", "", text, flags=re.I)


def answer_letters(answer, qtype):
    text = clean(answer).upper()
    if qtype == "??":
        if text in {"A", "TRUE"} or "?" in text or "??" in text:
            return ["A"]
        if text in {"B", "FALSE"} or "?" in text or "??" in text:
            return ["B"]
    letters = re.findall(r"[A-F]", text)
    seen = []
    for letter in letters:
        if letter not in seen:
            seen.append(letter)
    return seen


def row_dict(ws, row):
    headers = [clean(ws.cell(1, c).value) for c in range(1, ws.max_column + 1)]
    return {headers[c - 1]: ws.cell(row, c).value for c in range(1, ws.max_column + 1)}


def find_question_sheet(wb):
    required = {"??", "??", "??", "A", "B", "C", "D", "????"}
    for ws in wb.worksheets:
        headers = {clean(ws.cell(1, c).value) for c in range(1, ws.max_column + 1)}
        if required.issubset(headers):
            return ws
    raise ValueError("?????????????")


def validate_question(q, row_no, bank_label):
    errors = []
    if not q["categoryPath"]:
        errors.append(f"{bank_label} ?{row_no}???????")
    if q["questionType"] not in QUESTION_TYPES:
        errors.append(f"{bank_label} ?{row_no}???????")
    if not q["stem"]:
        errors.append(f"{bank_label} ?{row_no}???????")
    if q["questionType"] in {"??", "??"}:
        for letter in "ABCD":
            if not q["options"].get(letter):
                errors.append(f"{bank_label} ?{row_no}???{letter}????")
        if not q["answerLetters"]:
            errors.append(f"{bank_label} ?{row_no}????????????")
    if q["questionType"] == "??" and not q["answerLetters"]:
        errors.append(f"{bank_label} ?{row_no}?????????????/????/?")
    return errors


def normalize_row(raw, row_index, bank_key, bank_label, id_offset):
    qtype = normalize_type(raw.get("??"))
    chapter = split_path(raw.get("??"))
    answer = clean(raw.get("????"))
    options = {}
    for i, letter in enumerate(OPTION_LETTERS):
        value = raw.get(letter) if letter in raw else raw.get(f"??{letter}")
        value = strip_option_prefix(value, letter)
        if value:
            options[letter] = value
    if qtype == "??":
        options = {
            "A": options.get("A") or "??",
            "B": options.get("B") or "??",
        }
    source_id = clean(raw.get("??")) or f"{bank_key.upper()}{row_index:03d}"
    return {
        "id": id_offset + row_index,
        "sourceId": source_id,
        "bankScope": bank_key,
        "bankLabel": bank_label,
        "categoryPath": chapter,
        "categoryKey": " / ".join(chapter),
        "questionType": qtype,
        "stem": clean(raw.get("??")),
        "options": options,
        "answerLetters": answer_letters(answer, qtype),
        "answerText": answer,
        "explanation": clean(raw.get("??")),
        "tags": split_tags(raw.get("?????") or raw.get("?????")),
        "source": clean(raw.get("??/??")),
        "autoScore": True,
    }


def load_bank(config):
    wb = openpyxl.load_workbook(config["input"], data_only=True)
    ws = find_question_sheet(wb)
    questions = []
    errors = []
    for row in range(2, ws.max_row + 1):
        raw = row_dict(ws, row)
        if not any(clean(v) for v in raw.values()):
            continue
        q = normalize_row(raw, len(questions) + 1, config["key"], config["label"], config["id_offset"])
        row_errors = validate_question(q, row, config["label"])
        if row_errors:
            errors.extend(row_errors)
            continue
        questions.append(q)
    if errors:
        raise ValueError("\n".join(errors[:80]))
    if config.get("expected") and len(questions) != config["expected"]:
        raise ValueError(f"{config['label']} ???? {config['expected']}???? {len(questions)}")
    return questions


def count_by(items, field):
    counts = {}
    for q in items:
        counts[q[field]] = counts.get(q[field], 0) + 1
    return counts


def build_meta(banks):
    bank_scopes = [
        {"key": cfg["key"], "label": cfg["label"], "count": len(banks[cfg["key"]])}
        for cfg in BANK_CONFIGS
    ]
    meta = {
        "title": "????????????????????????",
        "questionCount": sum(len(items) for items in banks.values()),
        "defaultBankScope": "full",
        "bankScopes": bank_scopes,
        "questionTypes": QUESTION_TYPES,
        "generatedFrom": {cfg["key"]: cfg["input"].name for cfg in BANK_CONFIGS},
        "banks": {},
    }
    for cfg in BANK_CONFIGS:
        key = cfg["key"]
        questions = banks[key]
        meta["banks"][key] = {
            "label": cfg["label"],
            "questionCount": len(questions),
            "typeCounts": {qtype: 0 for qtype in QUESTION_TYPES},
            "chapterCounts": {},
        }
        meta["banks"][key]["typeCounts"].update(count_by(questions, "questionType"))
        meta["banks"][key]["chapterCounts"] = count_by(
            [{"chapter": q["categoryKey"]} for q in questions],
            "chapter",
        )
    return meta


def write_data_js(banks):
    meta = build_meta(banks)
    chunks = [
        "// Auto-generated from the Excel question banks. Do not edit by hand.",
        f"window.QUESTION_BANKS = {json.dumps(banks, ensure_ascii=False)};",
        "window.QUESTION_BANK = window.QUESTION_BANKS.full;",
        f"window.QUESTION_META = {json.dumps(meta, ensure_ascii=False)};",
        "window.QUESTION_SCHEMA = {questionTypes:['??','??','??']};",
        "",
    ]
    OUTPUT_JS.write_text("\n".join(chunks), encoding="utf-8")


def write_template():
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "??????"
    headers = ["??", "??", "??", "A", "B", "C", "D", "????", "??", "?????"]
    ws.append(headers)
    samples = [
        ["?? ???????????", "??", "????????????????????????? ??", "?????", "?????", "??????????", "?????", "A", "????????????????????????????", "?????"],
        ["??? ???????????", "??", "???????????? ??", "????", "????", "????", "????", "ABC", "?????????????????????????", "????"],
        ["??? ?????????", "??", "????????????????????????????", "??", "??", "", "", "??", "?????????????????", "????"],
    ]
    for row in samples:
        ws.append(row)
    header_fill = PatternFill("solid", fgColor="DCEBFF")
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.fill = header_fill
    widths = [28, 12, 56, 22, 22, 22, 22, 14, 56, 24]
    for i, width in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = width
    ws.freeze_panes = "A2"

    guide = wb.create_sheet("????")
    guide.append(["??", "????", "????"])
    guide_rows = [
        ["??", "?", "??????? / ?????????????/???"],
        ["??", "?", "?????????????"],
        ["??", "?", "????"],
        ["A-D", "??/????", "?????? ??/??"],
        ["????", "?", "??? A/B/C/D???? ABC/ABD???? ??/?? ? ?/?"],
        ["??", "?", "?????????"],
        ["?????", "?", "?? ? ? , ??????"],
    ]
    for row in guide_rows:
        guide.append(row)
    for cell in guide[1]:
        cell.font = Font(bold=True)
        cell.fill = header_fill
    guide.column_dimensions["A"].width = 18
    guide.column_dimensions["B"].width = 18
    guide.column_dimensions["C"].width = 80
    wb.save(TEMPLATE_XLSX)


def main():
    banks = {cfg["key"]: load_bank(cfg) for cfg in BANK_CONFIGS}
    write_data_js(banks)
    write_template()
    for cfg in BANK_CONFIGS:
        print(f"{cfg['label']}: {len(banks[cfg['key']])} questions from {cfg['input'].name}")
    print(f"Generated {OUTPUT_JS}.")
    print(f"Generated {TEMPLATE_XLSX}.")


if __name__ == "__main__":
    main()
