"""Evaluate model-selected decimal formulas without executing program code."""

import ast
from decimal import Decimal, DecimalException, localcontext
import operator
import re


IDENTIFIER = re.compile(r"[a-zA-Z][a-zA-Z0-9_]{0,23}")
DECIMAL = re.compile(r"[+-]?(?:\d{1,24}(?:\.\d{0,24})?|\.\d{1,24})(?:[eE][+-]?\d{1,2})?")
BINARY = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv}
FUNCTIONS = {"abs": abs, "sqrt": Decimal.sqrt, "ln": Decimal.ln, "log10": Decimal.log10}


def decimal_value(value):
    if not isinstance(value, str) or not DECIMAL.fullmatch(value):
        raise ValueError("数值请填写十进制字符串，百分数请先转成小数或在公式中除以 100。")
    number = Decimal(value)
    if not number.is_zero() and not -60 <= number.adjusted() <= 60:
        raise ValueError("数值超出计算范围。")
    return number


def bounded_text(item, field, size):
    value = item.get(field, "")
    if not isinstance(value, str) or len(value) > size:
        raise ValueError(f"{field} 需为不超过 {size} 字符的文本。")
    return value


def evaluate(node, expression, values, used):
    if isinstance(node, ast.Constant):
        return decimal_value(ast.get_source_segment(expression, node))
    if isinstance(node, ast.Name):
        if node.id not in values:
            raise ValueError(f"公式引用了未提供的变量 {node.id}。")
        if node.id not in used:
            used.append(node.id)
        return values[node.id]
    if isinstance(node, ast.UnaryOp) and type(node.op) in (ast.UAdd, ast.USub):
        value = evaluate(node.operand, expression, values, used)
        return -value if isinstance(node.op, ast.USub) else value
    if isinstance(node, ast.BinOp) and type(node.op) in (*BINARY, ast.Pow):
        left = evaluate(node.left, expression, values, used)
        right = evaluate(node.right, expression, values, used)
        if isinstance(node.op, ast.Pow):
            if right != right.to_integral_value() or not -12 <= right <= 12:
                raise ValueError("幂指数应为 -12 到 12 的整数。")
            return left ** int(right)
        return BINARY[type(node.op)](left, right)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
        name = node.func.id
        if name in FUNCTIONS and len(node.args) == 1:
            return FUNCTIONS[name](evaluate(node.args[0], expression, values, used))
        if name in ("min", "max", "sum") and 1 <= len(node.args) <= 24:
            items = [evaluate(arg, expression, values, used) for arg in node.args]
            return {"min": min, "max": max, "sum": sum}[name](items)
    raise ValueError("只接受十进制数、变量、基本算术和工具说明列出的函数。")


def calculate(payload):
    formulas = payload.get("formulas", [])
    variables = payload.get("variables", [])
    if not 1 <= len(formulas) <= 8 or len(variables) > 24:
        raise ValueError("每次提供 1 至 8 条算式和最多 24 个变量。")
    values = {}
    sources = {}
    for item in variables:
        name = bounded_text(item, "name", 24)
        if not IDENTIFIER.fullmatch(name) or name in values:
            raise ValueError("变量名须以英文字母开头并且不得重复。")
        values[name] = decimal_value(item.get("value"))
        sources[name] = {"name": name, "value": item["value"], "unit": bounded_text(item, "unit", 45),
                         "source": bounded_text(item, "source", 160)}
        if item.get("page") is not None:
            page = item["page"]
            if type(page) is not int or not 1 <= page <= 1200:
                raise ValueError("来源页码须为正整数且在支持的 PDF 页数范围内。")
            sources[name]["page"] = page
    results = []
    with localcontext(prec=28, Emax=60, Emin=-60) as context:
        for item in formulas:
            expression = bounded_text(item, "expression", 240).strip()
            unit = bounded_text(item, "unit", 45)
            label = bounded_text(item, "label", 100)
            try:
                if not expression or not expression.isascii() or not re.fullmatch(r"[a-zA-Z0-9_+*/.,() \-]+", expression):
                    raise ValueError("请用英文变量、半角字符和括号填写算式。")
                tree = ast.parse(expression, mode="eval")
                if sum(1 for _ in ast.walk(tree)) > 100:
                    raise ValueError("算式过长，请拆成几条。")
                used = []
                context.clear_flags()
                value = evaluate(tree.body, expression, values, used)
                if not value.is_finite() or (value and not -60 <= value.adjusted() <= 60):
                    raise ValueError("结果超出计算范围。")
                results.append({"label": label, "expression": expression,
                                "value": format(value.normalize(), "f") if value else "0", "unit": unit,
                                "inputs": used})
            except SyntaxError:
                results.append({"label": label, "expression": expression, "error": "无法解析算式。"})
            except DecimalException:
                results.append({"label": label, "expression": expression, "error": "计算时出现除零、溢出或函数定义域错误。"})
            except ValueError as error:
                results.append({"label": label, "expression": expression, "error": str(error)})
    return {"calculations": results, "variables": list(sources.values()),
            "note": "单位和来源由调用方提供。计算结果只验证给定算式。"}
