#[test]
fn production_builder_installs_tracing_once_and_repeated_init_is_safe() {
    let _builder = book_learner_app::application_builder(tauri::test::mock_builder());

    assert!(
        !book_learner_app::install_tracing(),
        "application_builder must install the process-wide subscriber before commands run"
    );
}
