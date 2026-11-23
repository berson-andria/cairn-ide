import json


def first_json_object(text):
    if not isinstance(text, str):
        raise ValueError("model response was not text")
    for start, char in enumerate(text):
        if char != "{":
            continue
        depth = 0
        in_string = False
        escaped = False
        for end in range(start, len(text)):
            current = text[end]
            if in_string:
                if escaped:
                    escaped = False
                elif current == "\\":
                    escaped = True
                elif current == '"':
                    in_string = False
                continue
            if current == '"':
                in_string = True
            elif current == "{":
                depth += 1
            elif current == "}":
                depth -= 1
                if depth == 0:
                    try:
                        result = json.loads(text[start : end + 1])
                    except json.JSONDecodeError:
                        break
                    if isinstance(result, dict):
                        return result
                    break
    raise ValueError("no valid JSON object found")
