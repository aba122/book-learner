use std::ffi::OsString;
use std::path::{Path, PathBuf};

use book_learner_core::models::{self, BookType};

fn parse_directory(arguments: impl IntoIterator<Item = OsString>) -> Result<PathBuf, String> {
    let arguments: Vec<OsString> = arguments.into_iter().collect();
    if arguments.len() != 1 {
        return Err("expected exactly one absolute data-directory argument".into());
    }
    let directory = PathBuf::from(&arguments[0]);
    if !directory.is_absolute() {
        return Err("data-directory argument must be an absolute path".into());
    }
    Ok(directory)
}

fn seed_directory(directory: &Path) -> book_learner_core::Result<PathBuf> {
    std::fs::create_dir_all(directory)?;
    let database_path = directory.join("app.db");
    let connection = book_learner_core::db::open(&database_path)?;
    let book_id = match models::list_books(&connection)?
        .into_iter()
        .find(|book| book.slug == "mac-smoke")
    {
        Some(book) => book.id,
        None => models::insert_book(
            &connection,
            "Mac 冒烟学习书",
            "book-learner",
            BookType::Textbook,
            "mac-smoke",
        )?,
    };

    let seeds = [
        (1, "建立模型", "model"),
        (2, "解释反馈", "feedback"),
        (3, "迁移应用", "application"),
    ];
    let mut blocks = models::list_blocks(&connection, book_id)?;
    for (sequence, title, slug) in seeds {
        if !blocks.iter().any(|block| block.slug == slug) {
            let prerequisites = blocks
                .last()
                .map(|block| vec![block.id])
                .unwrap_or_default();
            models::insert_block(
                &connection,
                book_id,
                "冒烟模块",
                sequence,
                title,
                slug,
                &prerequisites,
            )?;
            blocks = models::list_blocks(&connection, book_id)?;
        }
    }

    book_learner_core::planning::set_plan(
        &connection,
        &book_learner_core::planning::StudyPlan {
            book_id,
            deadline: "2026-12-31".into(),
            daily_new_blocks: 1,
            daily_cap: 4,
            remind_time: "21:00".into(),
        },
    )?;
    Ok(database_path)
}

fn run() -> Result<(), String> {
    let directory = parse_directory(std::env::args_os().skip(1))?;
    let database_path = seed_directory(&directory).map_err(|error| error.to_string())?;
    println!("{}", database_path.display());
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("seed_smoke: {error}");
        std::process::exit(2);
    }
}

#[cfg(test)]
mod tests {
    use super::OsString;

    #[test]
    fn directory_argument_must_be_exactly_one_absolute_path() {
        assert!(super::parse_directory(Vec::<OsString>::new()).is_err());
        assert!(super::parse_directory([OsString::from("relative")]).is_err());
        assert!(
            super::parse_directory([OsString::from("/tmp/one"), OsString::from("/tmp/two")])
                .is_err()
        );
        assert_eq!(
            super::parse_directory([OsString::from("/tmp/book-learner-seed")]).unwrap(),
            std::path::Path::new("/tmp/book-learner-seed")
        );
    }

    #[test]
    fn seeding_twice_keeps_one_book_three_blocks_and_one_plan() {
        let directory = tempfile::tempdir().unwrap();

        let first_path = super::seed_directory(directory.path()).unwrap();
        let second_path = super::seed_directory(directory.path()).unwrap();

        assert_eq!(first_path, directory.path().join("app.db"));
        assert_eq!(second_path, first_path);
        let connection = book_learner_core::db::open(&first_path).unwrap();
        let books = book_learner_core::models::list_books(&connection).unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(
            book_learner_core::models::list_blocks(&connection, books[0].id)
                .unwrap()
                .len(),
            3
        );
        let plan_count: i64 = connection
            .query_row("SELECT count(*) FROM study_plan", [], |row| row.get(0))
            .unwrap();
        assert_eq!(plan_count, 1);
    }
}
