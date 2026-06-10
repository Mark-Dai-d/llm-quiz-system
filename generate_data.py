import json
import re
from pathlib import Path

import openpyxl


ROOT = "大模型应用技术省赛"
INPUT = Path(r"C:\Users\14274\Desktop\大模型应用技术省赛完整备考总题库_570题.xlsx")
OUTPUT = Path(__file__).with_name("data.js")


def clean(value):
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def strip_option_prefix(value, letter):
    text = clean(value)
    if not text:
        return ""
    return re.sub(rf"^{letter}\s*[\.．、:：]\s*", "", text, flags=re.I)


def split_tags(value):
    text = clean(value)
    if not text:
        return []
    parts = re.split(r"[、,，;/；|]+", text)
    return [p.strip() for p in parts if p.strip()]


def answer_letters(answer, type_label):
    answer = clean(answer).upper()
    if "简答" in type_label:
        return []
    if "判断" in type_label:
        if "正确" in answer or answer == "TRUE":
            return ["A"]
        if "错误" in answer or answer == "FALSE":
            return ["B"]
    letters = re.findall(r"[A-F]", answer)
    seen = []
    for letter in letters:
        if letter not in seen:
            seen.append(letter)
    return seen


def question_type(type_label):
    if "简答" in type_label:
        return "essay"
    if "判断" in type_label:
        return "judge"
    if "多选" in type_label or "不定项" in type_label:
        return "multiple"
    return "single"


def node_id(parts):
    raw = "::".join(parts)
    safe = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff_-]+", "-", raw).strip("-")
    return safe or "root"


def add_tree_path(root, path, question_id):
    current = root
    so_far = []
    current.setdefault("questionIds", []).append(question_id)
    for name in path:
        so_far.append(name)
        children = current.setdefault("children", [])
        found = next((child for child in children if child["name"] == name), None)
        if not found:
            found = {
                "id": node_id(so_far),
                "name": name,
                "path": so_far[:],
                "questionIds": [],
                "children": [],
            }
            children.append(found)
        found["questionIds"].append(question_id)
        current = found


def row_dict(sheet, row):
    headers = [clean(sheet.cell(1, c).value) for c in range(1, sheet.max_column + 1)]
    return {headers[c - 1]: sheet.cell(row, c).value for c in range(1, sheet.max_column + 1)}


def table_records(sheet_name, wb):
    if sheet_name not in wb.sheetnames:
        return []
    ws = wb[sheet_name]
    headers = [clean(ws.cell(1, c).value) for c in range(1, ws.max_column + 1)]
    records = []
    for r in range(2, ws.max_row + 1):
        item = {}
        if not any(clean(ws.cell(r, c).value) for c in range(1, ws.max_column + 1)):
            continue
        for c, header in enumerate(headers, 1):
            item[header] = clean(ws.cell(r, c).value)
        records.append(item)
    return records


def main():
    wb = openpyxl.load_workbook(INPUT, data_only=True)
    ws = wb["01_题库"]
    questions = []
    tree = {
        "id": "root",
        "name": ROOT,
        "path": [ROOT],
        "questionIds": [],
        "children": [],
    }

    for row in range(2, ws.max_row + 1):
        raw = row_dict(ws, row)
        if not clean(raw.get("题干")):
            continue

        qid = len(questions) + 1
        source_id = clean(raw.get("题号")) or f"Q{qid:03d}"
        layer = clean(raw.get("层级")) or "未分层"
        module_id = clean(raw.get("模块编号"))
        module_name = clean(raw.get("模块名称")) or "未分模块"
        module = f"{module_id} {module_name}".strip()
        type_label = clean(raw.get("题型")) or "单选"
        qtype = question_type(type_label)
        topic = clean(raw.get("考点")) or "未归类考点"
        difficulty = clean(raw.get("难度")) or "未标注"
        tags = split_tags(raw.get("知识点标签"))
        options = {}
        for letter in "ABCDEF":
            text = strip_option_prefix(raw.get(f"选项{letter}"), letter)
            if text:
                options[letter] = text
        if qtype == "judge" and not options:
            options = {"A": "正确", "B": "错误"}

        letters = answer_letters(raw.get("答案"), type_label)
        path = [ROOT, layer, module, topic]
        question = {
            "id": qid,
            "sourceId": source_id,
            "layer": layer,
            "moduleId": module_id,
            "moduleName": module_name,
            "typeLabel": type_label,
            "type": qtype,
            "difficulty": difficulty,
            "topic": topic,
            "tags": tags,
            "stem": clean(raw.get("题干")),
            "options": options,
            "answerLetters": letters,
            "answerText": clean(raw.get("答案")),
            "explanation": clean(raw.get("解析")),
            "source": clean(raw.get("来源/依据")),
            "path": path,
            "pathKey": " / ".join(path),
            "autoScore": qtype != "essay",
        }
        questions.append(question)
        add_tree_path(tree, path, qid)

    metadata = {
        "title": "大模型应用技术省赛完整备考刷题系统",
        "root": ROOT,
        "questionCount": len(questions),
        "generatedFrom": INPUT.name,
        "typeCounts": {},
        "layerCounts": {},
    }
    for q in questions:
        metadata["typeCounts"][q["typeLabel"]] = metadata["typeCounts"].get(q["typeLabel"], 0) + 1
        metadata["layerCounts"][q["layer"]] = metadata["layerCounts"].get(q["layer"], 0) + 1

    payloads = {
        "QUESTION_BANK": questions,
        "HIERARCHY_TREE": tree,
        "KNOWLEDGE_SUMMARY": table_records("05_高频考点汇总表", wb),
        "CONFUSION_POINTS": table_records("06_易混知识点对比表", wb),
        "SOURCE_REFERENCES": table_records("08_资料来源", wb),
        "QUESTION_META": metadata,
    }
    chunks = [
        "// Auto-generated from the Excel question bank. Do not edit by hand.",
        f"window.QUESTION_BANK = {json.dumps(payloads['QUESTION_BANK'], ensure_ascii=False)};",
        f"window.HIERARCHY_TREE = {json.dumps(payloads['HIERARCHY_TREE'], ensure_ascii=False)};",
        f"window.KNOWLEDGE_SUMMARY = {json.dumps(payloads['KNOWLEDGE_SUMMARY'], ensure_ascii=False)};",
        f"window.CONFUSION_POINTS = {json.dumps(payloads['CONFUSION_POINTS'], ensure_ascii=False)};",
        f"window.SOURCE_REFERENCES = {json.dumps(payloads['SOURCE_REFERENCES'], ensure_ascii=False)};",
        f"window.QUESTION_META = {json.dumps(payloads['QUESTION_META'], ensure_ascii=False)};",
        "",
    ]
    OUTPUT.write_text("\n".join(chunks), encoding="utf-8")
    print(f"Generated {OUTPUT} with {len(questions)} questions.")


if __name__ == "__main__":
    main()
