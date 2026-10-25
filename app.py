import os
import hashlib, secrets, hmac
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from pydantic import BaseModel

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ---------- ডাটাবেস সংযোগ ----------
# অনলাইনে (Render) DATABASE_URL নামের Environment Variable থেকে ঠিকানা আসবে।
# লোকাল কম্পিউটারে সেটা না থাকলে XAMPP-এর ডিফল্ট (user = root, password = খালি) ব্যবহার হবে।
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "mysql+pymysql://root:@localhost:3306/question_organizer",
)

connect_args = {}
CA_PATH = os.path.join(BASE_DIR, "ca.pem")
if os.environ.get("DATABASE_URL") and os.path.exists(CA_PATH):
    # ক্লাউড ডাটাবেস (Aiven) নিরাপদ SSL সংযোগ চায়
    connect_args = {"ssl": {"ca": CA_PATH}}

engine = create_engine(
    DATABASE_URL,
    connect_args=connect_args,
    pool_pre_ping=True,   # সংযোগ বন্ধ হয়ে গেলে নিজে আবার জুড়ে নেবে
    pool_recycle=280,
)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SEMESTER_NAMES = {1: "1st Semester", 2: "2nd Semester", 3: "3rd Semester"}


# ---------- কোর্স ----------
@app.get("/api/courses")
def get_courses():
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT * FROM course ORDER BY semester, course_code")).mappings().all()
        return [dict(r) for r in rows]


# ---------- লগইন / রেজিস্ট্রেশন ----------
class LoginData(BaseModel):
    student_roll: str
    email: str
    batch: str
    semester: int
    password: str


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000).hex()
    return f"{salt}${h}"


def check_password(password: str, stored: str) -> bool:
    salt = stored.split("$")[0]
    return hmac.compare_digest(hash_password(password, salt), stored)


@app.post("/api/login")
def login(data: LoginData):
    email = data.email.strip().lower()
    roll = data.student_roll.strip()

    if len(data.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters.")

    try:
        with engine.begin() as conn:
            row = conn.execute(
                text("SELECT * FROM student WHERE student_roll = :r"), {"r": roll}
            ).mappings().first()

            if row:
                # আগে থেকে অ্যাকাউন্ট আছে, তাই পাসওয়ার্ড মেলানো হবে
                if row["email"] != email or not row["password_hash"] \
                        or not check_password(data.password, row["password_hash"]):
                    raise HTTPException(status_code=401, detail="Invalid email or password.")
                student_id = row["student_id"]
                message = "Login successful"
            else:
                # নতুন অ্যাকাউন্ট তৈরি
                result = conn.execute(text("""
                    INSERT INTO student (student_roll, email, batch, semester, password_hash)
                    VALUES (:r, :e, :b, :s, :p)
                """), {
                    "r": roll, "e": email, "b": data.batch,
                    "s": SEMESTER_NAMES.get(data.semester, "1st Semester"),
                    "p": hash_password(data.password),
                })
                student_id = result.lastrowid
                message = "Account created"
    except IntegrityError:
        raise HTTPException(status_code=400, detail="This email is already used by another student.")

    return {
        "message": message,
        "student_id": student_id,
        "student_roll": roll,
        "email": email,
        "batch": data.batch,
        "semester": data.semester,
    }


# ---------- রিসোর্স ----------
class ResourceIn(BaseModel):
    title: str
    student_roll: str
    course_id: int
    type: str
    exam: Optional[str] = "Not specified"
    year: Optional[str] = ""
    link: Optional[str] = ""


# সব approved রিসোর্স দেখা (JOIN দিয়ে)
@app.get("/api/resources")
def get_resources():
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT CAST(r.resource_id AS CHAR)                  AS id,
                   r.title                                      AS title,
                   c.course_name                                AS course,
                   CAST(SUBSTRING(c.semester, 1, 1) AS UNSIGNED) AS semester,
                   r.resource_type                              AS type,
                   COALESCE(r.exam_type, 'Not specified')       AS exam,
                   COALESCE(CAST(r.year AS CHAR), '')           AS year,
                   COALESCE(r.resource_link, '')                AS link,
                   s.student_roll                               AS owner,
                   'Approved'                                   AS status,
                   CAST(UNIX_TIMESTAMP(r.created_at) * 1000 AS SIGNED) AS created
            FROM resource r
            JOIN course  c ON r.course_id  = c.course_id
            JOIN student s ON r.student_id = s.student_id
            WHERE r.status = 'approved'
            ORDER BY r.created_at DESC
        """)).mappings().all()
        return [dict(r) for r in rows]


# নতুন রিসোর্স শেয়ার করা
@app.post("/api/resources")
def add_resource(data: ResourceIn):
    title = data.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title is required.")

    if data.type not in ("Notes", "Previous Questions", "Slides", "Other"):
        raise HTTPException(status_code=400, detail="Invalid material type.")

    year = int(data.year) if data.year and data.year.strip().isdigit() else None
    exam = None if (not data.exam or data.exam == "Not specified") else data.exam
    link = (data.link or "").strip() or None

    with engine.begin() as conn:
        student = conn.execute(
            text("SELECT student_id FROM student WHERE student_roll = :r"),
            {"r": data.student_roll},
        ).mappings().first()
        if not student:
            raise HTTPException(status_code=404, detail="Student not found. Please log in again.")

        course = conn.execute(
            text("SELECT course_id, semester FROM course WHERE course_id = :c"),
            {"c": data.course_id},
        ).mappings().first()
        if not course:
            raise HTTPException(status_code=404, detail="Course not found.")

        result = conn.execute(text("""
            INSERT INTO resource
                (title, resource_type, resource_link, semester, year, exam_type,
                 status, student_id, course_id)
            VALUES
                (:t, :ty, :l, :sem, :y, :e, 'approved', :sid, :cid)
        """), {
            "t": title, "ty": data.type, "l": link, "sem": course["semester"],
            "y": year, "e": exam, "sid": student["student_id"], "cid": course["course_id"],
        })

    return {"message": "Material added", "resource_id": result.lastrowid}


# ---------- বুকমার্ক ----------
class BookmarkIn(BaseModel):
    student_roll: str
    resource_id: int


# একজন student-এর সেভ করা রিসোর্সের id তালিকা
@app.get("/api/bookmarks/{student_roll}")
def get_bookmarks(student_roll: str):
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT CAST(b.resource_id AS CHAR) AS resource_id
            FROM bookmark b
            JOIN student s ON b.student_id = s.student_id
            WHERE s.student_roll = :r
        """), {"r": student_roll}).mappings().all()
        return [row["resource_id"] for row in rows]


# বুকমার্ক করা / তুলে নেওয়া (একই API)
@app.post("/api/bookmarks/toggle")
def toggle_bookmark(data: BookmarkIn):
    with engine.begin() as conn:
        student = conn.execute(
            text("SELECT student_id FROM student WHERE student_roll = :r"),
            {"r": data.student_roll},
        ).mappings().first()
        if not student:
            raise HTTPException(status_code=404, detail="Student not found. Please log in again.")

        resource = conn.execute(
            text("SELECT resource_id FROM resource WHERE resource_id = :r"),
            {"r": data.resource_id},
        ).mappings().first()
        if not resource:
            raise HTTPException(status_code=404, detail="Resource not found.")

        existing = conn.execute(text("""
            SELECT bookmark_id FROM bookmark
            WHERE student_id = :s AND resource_id = :r
        """), {"s": student["student_id"], "r": data.resource_id}).mappings().first()

        if existing:
            conn.execute(
                text("DELETE FROM bookmark WHERE bookmark_id = :b"),
                {"b": existing["bookmark_id"]},
            )
            return {"saved": False}

        conn.execute(text("""
            INSERT INTO bookmark (student_id, resource_id) VALUES (:s, :r)
        """), {"s": student["student_id"], "r": data.resource_id})
        return {"saved": True}


# ---------- ওয়েবসাইট (static ফোল্ডার) ----------
# এটা অবশ্যই সবার শেষে থাকতে হবে, নাহলে /api রুটগুলো ঢাকা পড়ে যাবে।
app.mount(
    "/",
    StaticFiles(directory=os.path.join(BASE_DIR, "static"), html=True),
    name="static",
)