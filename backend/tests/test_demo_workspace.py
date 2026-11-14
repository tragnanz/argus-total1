"""Accesso demo: l'utente creato in uno spazio separato non vede i clienti dell'organizzazione."""
import os
import tempfile

os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(tempfile.mkdtemp(), "demo.db")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


def test_demo_workspace_isolated():
    c = TestClient(app)
    tok = c.post("/api/auth/register", json={"email": "owner@x.it", "password": "password1",
                                              "organization_name": "Org"}).json()["access_token"]
    H = {"Authorization": f"Bearer {tok}"}
    assert c.post("/api/clients", json={"name": "Cliente riservato"}, headers=H).status_code == 201
    r = c.post("/api/admin/users", json={"email": "demo@x.it", "password": "password2", "full_name": "Ross",
                                         "credits": 50, "separate": True}, headers=H)
    assert r.status_code == 200 and r.json()["workspace"] == "Demo · Ross"
    r = c.post("/api/admin/users", json={"email": "team@x.it", "password": "password3"}, headers=H)
    assert r.json()["workspace"] is None
    users = {u["email"]: u for u in c.get("/api/admin/users", headers=H).json()}
    assert users["demo@x.it"]["workspace"] == "Demo · Ross" and "team@x.it" in users
    # il demo vede solo il proprio spazio
    td = c.post("/api/auth/login", json={"email": "demo@x.it", "password": "password2"}).json()["access_token"]
    HD = {"Authorization": f"Bearer {td}"}
    assert c.get("/api/clients", headers=HD).json() == []
    assert c.post("/api/clients", json={"name": "Demo farm"}, headers=HD).status_code == 201
    assert [x["name"] for x in c.get("/api/clients", headers=H).json()] == ["Cliente riservato"]
    tt = c.post("/api/auth/login", json={"email": "team@x.it", "password": "password3"}).json()["access_token"]
    assert [x["name"] for x in c.get("/api/clients", headers={"Authorization": f"Bearer {tt}"}).json()] == ["Cliente riservato"]
    # l'owner gestisce anche l'utente demo
    uid = users["demo@x.it"]["id"]
    assert c.patch(f"/api/admin/users/{uid}", json={"is_active": False}, headers=H).status_code == 200
    assert c.post("/api/auth/login", json={"email": "demo@x.it", "password": "password2"}).status_code == 403
