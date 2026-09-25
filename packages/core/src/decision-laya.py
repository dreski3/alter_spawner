import json
import sys

import laya_mlx as laya


def main():
    request = json.load(sys.stdin)
    agent = laya.load(request["model_dir"], dtype="float16")
    answer = agent.predict(
        request["signal"],
        {
            "route": {
                "type": "choice",
                "instructions": request["instructions"],
                "criteria": {route["id"]: route["description"] for route in request["routes"]},
            }
        },
    )["answers"]["route"]
    json.dump({"id": answer["choice"]}, sys.stdout)


if __name__ == "__main__":
    main()
