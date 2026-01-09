use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub name: String,
    pub cover_file_id: String,
    pub count: i32,
    pub description: Option<String>,
    pub face_box: Option<FaceBox>,
    pub updated_at: Option<i64>,
}

pub fn get_all_people(conn: &Connection) -> Result<Vec<Person>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, cover_file_id, count, description, 
                face_box_x, face_box_y, face_box_w, face_box_h, updated_at 
         FROM persons"
    )?;
    
    let person_iter = stmt.query_map([], |row| {
        let face_box_x: Option<f64> = row.get(5)?;
        let face_box = if let Some(x) = face_box_x {
            Some(FaceBox {
                x,
                y: row.get(6)?,
                w: row.get(7)?,
                h: row.get(8)?,
            })
        } else {
            None
        };

        Ok(Person {
            id: row.get(0)?,
            name: row.get(1)?,
            cover_file_id: row.get(2)?,
            count: row.get(3)?,
            description: row.get(4)?,
            face_box,
            updated_at: row.get(9)?,
        })
    })?;

    let mut people = Vec::new();
    for person in person_iter {
        people.push(person?);
    }
    Ok(people)
}

pub fn upsert_person(conn: &Connection, person: &Person) -> Result<()> {
    let (x, y, w, h) = if let Some(box_) = &person.face_box {
        (Some(box_.x), Some(box_.y), Some(box_.w), Some(box_.h))
    } else {
        (None, None, None, None)
    };

    conn.execute(
        "INSERT INTO persons (id, name, cover_file_id, count, description, 
                              face_box_x, face_box_y, face_box_w, face_box_h, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            cover_file_id = excluded.cover_file_id,
            count = excluded.count,
            description = excluded.description,
            face_box_x = excluded.face_box_x,
            face_box_y = excluded.face_box_y,
            face_box_w = excluded.face_box_w,
            face_box_h = excluded.face_box_h,
            updated_at = excluded.updated_at",
        params![
            person.id,
            person.name,
            person.cover_file_id,
            person.count,
            person.description,
            x, y, w, h,
            person.updated_at
        ],
    )?;
    Ok(())
}

pub fn update_person_avatar(conn: &Connection, person_id: &str, cover_file_id: &str, face_box: Option<&FaceBox>) -> Result<()> {
    let (x, y, w, h) = if let Some(box_) = face_box {
        (Some(box_.x), Some(box_.y), Some(box_.w), Some(box_.h))
    } else {
        (None, None, None, None)
    };

    conn.execute(
        "UPDATE persons SET 
            cover_file_id = ?2, 
            face_box_x = ?3, face_box_y = ?4, face_box_w = ?5, face_box_h = ?6,
            updated_at = strftime('%s', 'now') * 1000
         WHERE id = ?1",
        params![person_id, cover_file_id, x, y, w, h],
    )?;
    Ok(())
}

pub fn delete_person(conn: &Connection, person_id: &str) -> Result<()> {
    conn.execute("DELETE FROM persons WHERE id = ?1", params![person_id])?;
    Ok(())
}
