import json
import re
from pathlib import Path

import openpyxl
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter


INPUT = Path(r"C:\Users\14274\Desktop\大模型应用技术省赛完整备考总题库_570题.xlsx")
OUTPUT_JS = Path(__file__).with_name("data.js")
TEMPLATE_XLSX = Path(__file__).with_name("题库导入模板.xlsx")

DIFFICULTY_LAYERS = ["基础层", "进阶层", "冲刺层"]
QUESTION_TYPES = ["单选", "多选", "判断", "简答"]
OPTION_LETTERS = list("ABCDEF")


def clean(value):
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def split_path(value):
    text = clean(value)
    if not text:
        return []
    return [p.strip() for p in re.split(r"[/／>＞\\|]+", text) if p.strip()]


def split_tags(value):
    text = clean(value)
    if not text:
        return []
    return [p.strip() for p in re.split(r"[、,，;/；|]+", text) if p.strip()]


def strip_option_prefix(value, letter):
    text = clean(value)
    if not text:
        return ""
    return re.sub(rf"^{letter}\s*[\.．、:：]\s*", "", text, flags=re.I)


def normalize_layer(value):
    text = clean(value)
    if text in DIFFICULTY_LAYERS:
        return text
    if "基" in text:
        return "基础层"
    if "进" in text:
        return "进阶层"
    if "冲" in text:
        return "冲刺层"
    return ""


def normalize_type(value):
    text = clean(value)
    if "简答" in text:
        return "简答"
    if "判断" in text:
        return "判断"
    if "多选" in text or "不定项" in text:
        return "多选"
    if "单选" in text or text:
        return "单选"
    return ""


def answer_letters(answer, qtype):
    text = clean(answer).upper()
    if qtype == "简答":
        return []
    if qtype == "判断":
        if text in {"A", "TRUE"} or "对" in text or "正确" in text:
            return ["A"]
        if text in {"B", "FALSE"} or "错" in text or "错误" in text:
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
    preferred_headers = {"难度层级", "知识分类", "题型", "题干", "标准答案"}
    for ws in wb.worksheets:
        headers = {clean(ws.cell(1, c).value) for c in range(1, ws.max_column + 1)}
        if preferred_headers.issubset(headers):
            return ws, "template"
    return wb["01_题库"], "legacy"


def legacy_category(raw):
    module_id = clean(raw.get("模块编号"))
    module_name = clean(raw.get("模块名称")) or "未分模块"
    topic = clean(raw.get("考点")) or "未归类考点"
    module = f"{module_id} {module_name}".strip()
    return [module, topic]


def template_category(raw):
    parts = split_path(raw.get("知识分类"))
    return parts or ["未分分类"]


def validate_question(q, row_no):
    errors = []
    if q["difficultyLayer"] not in DIFFICULTY_LAYERS:
        errors.append(f"第{row_no}行难度层级填写错误")
    if not q["categoryPath"]:
        errors.append(f"第{row_no}行知识分类不能为空")
    if q["questionType"] not in QUESTION_TYPES:
        errors.append(f"第{row_no}行题型填写错误")
    if not q["stem"]:
        errors.append(f"第{row_no}行题干不能为空")
    if q["questionType"] in {"单选", "多选"}:
        for letter in "ABCD":
            if not q["options"].get(letter):
                errors.append(f"第{row_no}行选项{letter}不能为空")
        if not q["answerLetters"]:
            errors.append(f"第{row_no}行标准答案应填写选项字母")
    if q["questionType"] == "判断" and not q["answerLetters"]:
        errors.append(f"第{row_no}行判断题标准答案应填写对/错")
    if q["questionType"] == "简答" and not q["answerText"]:
        errors.append(f"第{row_no}行简答题标准答案不能为空")
    return errors


def load_questions():
    wb = openpyxl.load_workbook(INPUT, data_only=True)
    ws, mode = find_question_sheet(wb)
    questions = []
    errors = []

    for row in range(2, ws.max_row + 1):
        raw = row_dict(ws, row)
        if not any(clean(v) for v in raw.values()):
            continue

        if mode == "template":
            layer = normalize_layer(raw.get("难度层级"))
            qtype = normalize_type(raw.get("题型"))
            category = template_category(raw)
            stem = clean(raw.get("题干"))
            answer = clean(raw.get("标准答案"))
            explanation = clean(raw.get("解析"))
            source_id = clean(raw.get("题号")) or f"Q{len(questions) + 1:03d}"
            tags = split_tags(raw.get("知识点标签"))
            source = clean(raw.get("来源/依据"))
        else:
            layer = normalize_layer(raw.get("层级"))
            qtype = normalize_type(raw.get("题型"))
            category = legacy_category(raw)
            stem = clean(raw.get("题干"))
            answer = clean(raw.get("答案"))
            explanation = clean(raw.get("解析"))
            source_id = clean(raw.get("题号")) or f"Q{len(questions) + 1:03d}"
            tags = split_tags(raw.get("知识点标签"))
            source = clean(raw.get("来源/依据"))

        options = {}
        for letter in OPTION_LETTERS:
            value = strip_option_prefix(raw.get(f"选项{letter}"), letter)
            if value:
                options[letter] = value
        if qtype == "判断":
            options = {"A": "对", "B": "错"}

        q = {
            "id": len(questions) + 1,
            "sourceId": source_id,
            "difficultyLayer": layer,
            "categoryPath": category,
            "categoryKey": " / ".join(category),
            "questionType": qtype,
            "stem": stem,
            "options": options,
            "answerLetters": answer_letters(answer, qtype),
            "answerText": answer,
            "explanation": explanation,
            "tags": tags,
            "source": source,
            "autoScore": qtype != "简答",
        }
        row_errors = validate_question(q, row)
        if row_errors:
            errors.extend(row_errors)
            continue
        questions.append(q)

    if errors:
        raise ValueError("\n".join(errors[:50]))
    return questions


def build_meta(questions):
    meta = {
        "title": "大模型应用技术省赛刷题系统",
        "questionCount": len(questions),
        "difficultyLayers": DIFFICULTY_LAYERS,
        "questionTypes": QUESTION_TYPES,
        "generatedFrom": INPUT.name,
        "layerCounts": {layer: 0 for layer in DIFFICULTY_LAYERS},
        "typeCounts": {qtype: 0 for qtype in QUESTION_TYPES},
    }
    for q in questions:
        meta["layerCounts"][q["difficultyLayer"]] += 1
        meta["typeCounts"][q["questionType"]] += 1
    return meta


def write_data_js(questions):
    meta = build_meta(questions)
    chunks = [
        "// Auto-generated from the Excel question bank. Do not edit by hand.",
        f"window.QUESTION_BANK = {json.dumps(questions, ensure_ascii=False)};",
        f"window.QUESTION_META = {json.dumps(meta, ensure_ascii=False)};",
        "window.QUESTION_SCHEMA = {difficultyLayers:['基础层','进阶层','冲刺层'],questionTypes:['单选','多选','判断','简答']};",
        "",
    ]
    OUTPUT_JS.write_text("\n".join(chunks), encoding="utf-8")


def write_template():
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "题目导入模板"
    headers = [
        "难度层级",
        "知识分类",
        "题型",
        "题干",
        "选项A",
        "选项B",
        "选项C",
        "选项D",
        "选项E",
        "选项F",
        "标准答案",
        "解析",
        "知识点标签",
        "来源/依据",
    ]
    ws.append(headers)
    samples = [
        ["基础层", "M1 大模型基础概念/Token", "单选", "Token 通常指什么？", "最小语义/文本切分单元", "模型参数", "数据库表", "网络协议", "", "", "A", "Token 是模型处理文本的基本切分单元。", "Token、基础概念", ""],
        ["进阶层", "M3 提示词工程/结构化提示", "多选", "以下属于结构化提示词常见要素的是？", "角色", "任务", "约束", "输出格式", "", "", "ABCD", "结构化提示一般包含角色、任务、约束和输出格式。", "提示词工程", ""],
        ["基础层", "M1 大模型基础概念/判断", "判断", "大模型输出一定完全准确。", "", "", "", "", "", "", "错", "大模型存在幻觉风险。", "能力边界", ""],
        ["冲刺层", "场景案例专项/综合分析", "简答", "简述企业落地 RAG 时应关注的关键环节。", "", "", "", "", "", "", "参考答案：知识库清洗、切分、向量化、召回、重排、权限与评测。", "围绕数据治理、检索质量和安全合规展开。", "RAG、落地实践", ""],
    ]
    for row in samples:
        ws.append(row)

    header_fill = PatternFill("solid", fgColor="DCEBFF")
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.fill = header_fill
    widths = [14, 34, 12, 50, 18, 18, 18, 18, 18, 18, 18, 46, 24, 24]
    for i, width in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = width
    ws.freeze_panes = "A2"

    guide = wb.create_sheet("填写规范")
    guide.append(["字段", "是否必填", "填写规范"])
    guide_rows = [
        ["难度层级", "是", "只能填写：基础层、进阶层、冲刺层"],
        ["知识分类", "是", "用 / 分隔多级分类，例如：模块/章节/小节"],
        ["题型", "是", "只能填写：单选、多选、判断、简答"],
        ["选项A-D", "单选/多选必填", "判断题和简答题可留空；选项E/F为兼容不定项题的可选扩展列"],
        ["标准答案", "是", "单选填 A/B/C/D；多选填 ABC/ABD；判断填 对/错；简答填参考答案文本"],
        ["解析", "否", "题目解析或背诵要点"],
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
    questions = load_questions()
    write_data_js(questions)
    write_template()
    print(f"Generated {OUTPUT_JS} with {len(questions)} questions.")
    print(f"Generated {TEMPLATE_XLSX}.")


if __name__ == "__main__":
    main()
