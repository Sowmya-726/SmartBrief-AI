import os
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from fastapi import Cookie
from fastapi import Depends
from fastapi import HTTPException
from fastapi import Response
from jose import JWTError
from jose import jwt
from passlib.context import CryptContext
from pydantic import BaseModel
from pydantic import EmailStr


DB_PATH = Path(os.getenv("AUTH_DB_PATH", "auth.db"))

JWT_SECRET = os.getenv("AUTH_JWT_SECRET", "dev-secret-change-me")
JWT_ALG = "HS256"
JWT_TTL_SECONDS = int(os.getenv("AUTH_JWT_TTL_SECONDS", "86400"))  # 24h
COOKIE_NAME = "aimm_session"

# Use PBKDF2-SHA256 for broad compatibility (no native bcrypt backend issues on Windows).
pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")


def _conn() -> sqlite3.Connection:
  conn = sqlite3.connect(DB_PATH)
  conn.row_factory = sqlite3.Row
  return conn


def init_auth_db() -> None:
  DB_PATH.parent.mkdir(parents=True, exist_ok=True)
  with _conn() as conn:
    conn.execute(
      """
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
      """
    )
    conn.commit()


def hash_password(password: str) -> str:
  return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
  return pwd_context.verify(password, password_hash)


def create_token(email: str) -> str:
  now = int(time.time())
  payload = {
    "sub": email,
    "iat": now,
    "exp": now + JWT_TTL_SECONDS,
  }
  return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def decode_token(token: str) -> str:
  try:
    payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
  except JWTError as exc:
    raise HTTPException(status_code=401, detail="Invalid or expired session.") from exc
  email = payload.get("sub")
  if not email:
    raise HTTPException(status_code=401, detail="Invalid session payload.")
  return str(email)


def get_user_by_email(email: str) -> Optional[sqlite3.Row]:
  with _conn() as conn:
    return conn.execute("SELECT * FROM users WHERE email = ?", (email.lower(),)).fetchone()


def create_user(email: str, password: str) -> None:
  email_norm = email.lower().strip()
  if not email_norm:
    raise HTTPException(status_code=400, detail="Email is required.")
  if len(password) < 6:
    raise HTTPException(status_code=400, detail="Password must be at least 6 characters.")

  password_hash = hash_password(password)
  with _conn() as conn:
    try:
      conn.execute(
        "INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)",
        (email_norm, password_hash, int(time.time())),
      )
      conn.commit()
    except sqlite3.IntegrityError as exc:
      raise HTTPException(status_code=409, detail="An account with this email already exists.") from exc


def authenticate_user(email: str, password: str) -> None:
  row = get_user_by_email(email)
  if not row:
    raise HTTPException(status_code=401, detail="Invalid email or password.")
  if not verify_password(password, row["password_hash"]):
    raise HTTPException(status_code=401, detail="Invalid email or password.")


def set_session_cookie(response: Response, token: str) -> None:
  # In dev/local, Secure=False is required for http://.
  # Keep SameSite=Lax to reduce CSRF risk.
  response.set_cookie(
    key=COOKIE_NAME,
    value=token,
    httponly=True,
    secure=False,
    samesite="lax",
    path="/",
    max_age=JWT_TTL_SECONDS,
  )


def clear_session_cookie(response: Response) -> None:
  response.delete_cookie(key=COOKIE_NAME, path="/")


class RegisterRequest(BaseModel):
  email: EmailStr
  password: str


class LoginRequest(BaseModel):
  email: EmailStr
  password: str


class AuthMeResponse(BaseModel):
  email: EmailStr


@dataclass
class AuthedUser:
  email: str


def get_current_user(session: Optional[str] = Cookie(default=None, alias=COOKIE_NAME)) -> AuthedUser:
  if not session:
    raise HTTPException(status_code=401, detail="Not authenticated.")
  email = decode_token(session)
  # Ensure user still exists (supports account deletion later).
  if not get_user_by_email(email):
    raise HTTPException(status_code=401, detail="Account not found.")
  return AuthedUser(email=email)


def require_user(user: AuthedUser = Depends(get_current_user)) -> AuthedUser:
  return user

