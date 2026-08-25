# ProxyWar tournament commissioner: the config-driven ruleset_strategy framework (vendored from
# Metta-AI/coworld-tools `commissioners/`) plus one custom override (ProxyWarCommissioner in
# commissioners/proxywar_app.py) that routes each Competition round to a seat-count ladder
# (2p/4p/8p/12p) sized to how many real policies are currently in the league. Built and bundled by
# `coworld build` as this coworld's `commissioner` runnable.
FROM ghcr.io/astral-sh/uv:0.11.7@sha256:240fb85ab0f263ef12f492d8476aa3a2e4e1e333f7d67fbdd923d00a506a516a AS uv
FROM python:3.13-slim@sha256:ffb752e139c0a19692a43af8d8523b274222dd68eebad5d583b45c2201c6e30a

# No COMMISSIONER_KEY here, deliberately: commissioners/proxywar_app.py builds its FastAPI `app`
# by passing the key directly to commissioner_app("proxywar_scaling"), not via this env var.
# commissioners/common/app.py -- imported as a side effect of importing proxywar_app -- ALSO builds
# its own throwaway default app at import time using COMMISSIONER_KEY (or "config_driven" if unset);
# setting it to "proxywar_scaling" here would make that eager, unrelated construction run before
# proxywar_app.py has registered the class, and crash the import with "Unknown commissioner_key".
ENV RULESET_STRATEGY_CONFIG_NAME=proxywar \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY --from=uv /uv /uvx /bin/
COPY pyproject.toml uv.lock README.md /app/
COPY commissioners /app/commissioners

RUN uv sync --frozen --no-dev --no-editable
ENV PATH="/app/.venv/bin:${PATH}"

EXPOSE 8080
CMD ["uvicorn", "commissioners.proxywar_app:app", "--host", "0.0.0.0", "--port", "8080"]
