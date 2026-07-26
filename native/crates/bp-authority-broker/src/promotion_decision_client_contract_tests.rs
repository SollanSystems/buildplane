use crate::promotion_decision_client::{
    encode_promotion_decision_request_frame, parse_client_request_stdin,
    parse_protected_client_config_json, validate_client_config_file_facts,
    validate_client_executable_facts, validate_client_parent_facts,
    validate_connected_listener_creator_for_test, validate_socket_facts,
    ClientConfigDescriptorFactsV1, ClientConfigDescriptorKindV1, ClientParentDescriptorFactsV1,
    PromotionDecisionClientStatusV1, SocketDescriptorFactsV1, SocketDescriptorKindV1,
};
use crate::promotion_decision_response::{
    sign_promotion_decision_response_for_test, PromotionDecisionResponseBindingV1,
    PromotionDecisionResponseStatusV1,
};
use ed25519_dalek::SigningKey;

const APPROVAL_EVENT_ID: &str = "123e4567-e89b-12d3-a456-426614174001";

#[test]
fn client_input_is_closed_and_requires_a_canonical_approval_event_uuid() {
    let parsed = parse_client_request_stdin(
        br#"{"schema_version":1,"promotion_approval_request_event_id":"123e4567-e89b-12d3-a456-426614174001","decision":"promote"}"#,
    )
    .expect("closed canonical input");
    assert_eq!(
        parsed.promotion_approval_request_event_id(),
        APPROVAL_EVENT_ID
    );
    assert_eq!(parsed.decision(), "promote");

    for rejected in [
        br#"{"schema_version":1,"promotion_approval_request_event_id":"123E4567-E89B-12D3-A456-426614174001","decision":"promote"}"#.as_slice(),
        br#"{"schema_version":1,"promotion_approval_request_event_id":"host-recovery/promotion-decision","decision":"promote"}"#.as_slice(),
        br#"{"schema_version":1,"promotion_approval_request_event_id":"123e4567-e89b-12d3-a456-426614174001","decision":"promote","socket_path":"/tmp/fake.sock"}"#.as_slice(),
        br#"{"schema_version":1,"promotion_approval_request_event_id":"123e4567-e89b-12d3-a456-426614174001","decision":"approve"}"#.as_slice(),
    ] {
        assert!(parse_client_request_stdin(rejected).is_err());
    }
}

#[test]
fn protected_client_config_is_closed_and_pins_listener_and_broker_identity() {
    let public_key = SigningKey::from_bytes(&[24; 32]).verifying_key().to_bytes();
    let config_json = serde_json::json!({
        "schema_version": 1,
        "listener_creator_uid": 0,
        "socket_group_gid": 1002,
        "broker_identity_public_key": public_key,
    })
    .to_string();
    let config =
        parse_protected_client_config_json(config_json.as_bytes()).expect("closed client config");
    assert_eq!(config.listener_creator_uid(), 0);
    assert_eq!(config.socket_group_gid(), 1002);
    assert_eq!(config.broker_identity_public_key().to_bytes(), public_key);

    let mut non_root_listener: serde_json::Value = serde_json::from_str(&config_json).unwrap();
    non_root_listener["listener_creator_uid"] = serde_json::json!(1);
    let mut short_key: serde_json::Value = serde_json::from_str(&config_json).unwrap();
    short_key["broker_identity_public_key"] = serde_json::json!([24]);
    let mut legacy_broker_uid: serde_json::Value = serde_json::from_str(&config_json).unwrap();
    legacy_broker_uid["broker_uid"] = serde_json::json!(1001);
    let mut wrong_version: serde_json::Value = serde_json::from_str(&config_json).unwrap();
    wrong_version["schema_version"] = serde_json::json!(2);
    for rejected in [
        non_root_listener,
        short_key,
        legacy_broker_uid,
        wrong_version,
    ] {
        assert!(parse_protected_client_config_json(rejected.to_string().as_bytes()).is_err());
    }
}

#[test]
fn client_config_descriptor_requires_root_owned_regular_0644_single_link_file() {
    let valid =
        ClientConfigDescriptorFactsV1::new(ClientConfigDescriptorKindV1::RegularFile, 0, 0o644, 1);
    assert!(validate_client_config_file_facts(valid).is_ok());

    for invalid in [
        ClientConfigDescriptorFactsV1::new(ClientConfigDescriptorKindV1::Symlink, 0, 0o644, 1),
        ClientConfigDescriptorFactsV1::new(
            ClientConfigDescriptorKindV1::RegularFile,
            1000,
            0o644,
            1,
        ),
        ClientConfigDescriptorFactsV1::new(ClientConfigDescriptorKindV1::RegularFile, 0, 0o664, 1),
        ClientConfigDescriptorFactsV1::new(ClientConfigDescriptorKindV1::RegularFile, 0, 0o644, 2),
    ] {
        assert!(validate_client_config_file_facts(invalid).is_err());
    }
}

#[test]
fn request_frame_is_bounded_canonical_and_uses_a_fresh_request_uuid() {
    let request = parse_client_request_stdin(
        br#"{"schema_version":1,"promotion_approval_request_event_id":"123e4567-e89b-12d3-a456-426614174001","decision":"reject"}"#,
    )
    .expect("closed request");
    let first = encode_promotion_decision_request_frame(&request).expect("first frame");
    let second = encode_promotion_decision_request_frame(&request).expect("second frame");

    assert_ne!(
        first, second,
        "each operator submission gets fresh correlation"
    );
    for frame in [first, second] {
        let payload_length = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
        assert_eq!(payload_length, frame.len() - 4);
        let payload = std::str::from_utf8(&frame[4..]).unwrap();
        assert!(payload.starts_with(r#"{"request_id":""#));
        assert!(payload.ends_with(
            r#"","promotion_approval_request_event_id":"123e4567-e89b-12d3-a456-426614174001","decision":"reject"}"#
        ));
    }
}

#[test]
fn fixed_path_parents_socket_and_connected_peer_are_all_identity_checked() {
    assert!(
        validate_client_parent_facts(ClientParentDescriptorFactsV1::new(
            ClientConfigDescriptorKindV1::Other,
            0,
            0o755,
        ))
        .is_err()
    );
    assert!(
        validate_client_parent_facts(ClientParentDescriptorFactsV1::new(
            ClientConfigDescriptorKindV1::RegularFile,
            0,
            0o755,
        ))
        .is_err()
    );
    assert!(
        validate_client_parent_facts(ClientParentDescriptorFactsV1::new(
            ClientConfigDescriptorKindV1::Directory,
            0,
            0o755,
        ))
        .is_ok()
    );
    assert!(
        validate_client_parent_facts(ClientParentDescriptorFactsV1::new(
            ClientConfigDescriptorKindV1::Directory,
            1000,
            0o755,
        ))
        .is_err()
    );
    assert!(
        validate_client_parent_facts(ClientParentDescriptorFactsV1::new(
            ClientConfigDescriptorKindV1::Directory,
            0,
            0o775,
        ))
        .is_err()
    );

    let socket = SocketDescriptorFactsV1::new(
        SocketDescriptorKindV1::UnixSocket,
        0,
        1002,
        0o660,
        1,
        42,
        84,
    );
    assert!(validate_socket_facts(socket, 1002).is_ok());
    assert!(validate_socket_facts(
        SocketDescriptorFactsV1::new(SocketDescriptorKindV1::Symlink, 0, 1002, 0o660, 1, 42, 84,),
        1002,
    )
    .is_err());
    assert!(validate_socket_facts(
        SocketDescriptorFactsV1::new(SocketDescriptorKindV1::UnixSocket, 0, 999, 0o660, 1, 42, 84,),
        1002,
    )
    .is_err());

    #[cfg(target_os = "linux")]
    {
        use std::os::unix::net::UnixStream;
        let (client, _server) = UnixStream::pair().expect("local connected stream");
        let current_uid = unsafe { libc::geteuid() };
        assert!(validate_connected_listener_creator_for_test(&client, current_uid).is_ok());
        let wrong_uid = current_uid.checked_add(1).unwrap_or(current_uid - 1);
        assert!(validate_connected_listener_creator_for_test(&client, wrong_uid).is_err());
    }
}

#[cfg(target_os = "linux")]
#[test]
fn systemd_style_listener_creator_is_the_client_peer_not_the_acceptor_process() {
    use std::io::{Read, Write};
    use std::os::fd::AsRawFd;
    use std::os::unix::net::{UnixListener, UnixStream};

    let directory = tempfile::tempdir().unwrap();
    let socket_path = directory.path().join("activation.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let listener_creator_pid = unsafe { libc::getpid() };
    let listener_creator_uid = unsafe { libc::geteuid() };
    let signing_key = SigningKey::from_bytes(&[32; 32]);
    let verifying_key = signing_key.verifying_key();

    let acceptor_pid = unsafe { libc::fork() };
    assert!(acceptor_pid >= 0);
    if acceptor_pid == 0 {
        let result = listener.accept().and_then(|(mut stream, _)| {
            let mut header = [0_u8; 4];
            stream.read_exact(&mut header)?;
            let mut payload = vec![0_u8; u32::from_be_bytes(header) as usize];
            stream.read_exact(&mut payload)?;
            let request_wire: serde_json::Value =
                serde_json::from_slice(&payload).map_err(std::io::Error::other)?;
            let response = sign_promotion_decision_response_for_test(
                &signing_key,
                PromotionDecisionResponseBindingV1::new(
                    request_wire["request_id"].as_str().unwrap(),
                    APPROVAL_EVENT_ID,
                    "promote",
                )
                .unwrap(),
                PromotionDecisionResponseStatusV1::Sealed,
            )
            .unwrap();
            stream.write_all(&(response.len() as u32).to_be_bytes())?;
            stream.write_all(&response)
        });
        unsafe { libc::_exit(if result.is_ok() { 0 } else { 1 }) };
    }

    let mut client = UnixStream::connect(&socket_path).unwrap();

    let mut credentials = std::mem::MaybeUninit::<libc::ucred>::zeroed();
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    assert_eq!(
        unsafe {
            libc::getsockopt(
                client.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                credentials.as_mut_ptr().cast(),
                std::ptr::addr_of_mut!(length),
            )
        },
        0
    );
    let credentials = unsafe { credentials.assume_init() };
    assert_eq!(credentials.pid, listener_creator_pid);
    assert_ne!(credentials.pid, acceptor_pid);
    assert_eq!(credentials.uid, listener_creator_uid);
    assert!(validate_connected_listener_creator_for_test(&client, listener_creator_uid).is_ok());
    let request = parse_client_request_stdin(
        br#"{"schema_version":1,"promotion_approval_request_event_id":"123e4567-e89b-12d3-a456-426614174001","decision":"promote"}"#,
    )
    .unwrap();
    assert_eq!(
        crate::promotion_decision_client::exchange_promotion_decision_with_stream_for_test(
            &mut client,
            listener_creator_uid,
            &verifying_key,
            &request,
        )
        .unwrap(),
        PromotionDecisionClientStatusV1::Sealed
    );

    let mut status = 0;
    assert_eq!(
        unsafe { libc::waitpid(acceptor_pid, &mut status, 0) },
        acceptor_pid
    );
    assert!(libc::WIFEXITED(status));
    assert_eq!(libc::WEXITSTATUS(status), 0);
}

#[test]
fn installed_client_executable_must_be_root_owned_regular_0755_single_link() {
    let valid =
        ClientConfigDescriptorFactsV1::new(ClientConfigDescriptorKindV1::RegularFile, 0, 0o755, 1);
    assert!(validate_client_executable_facts(valid).is_ok());
    for invalid in [
        ClientConfigDescriptorFactsV1::new(
            ClientConfigDescriptorKindV1::RegularFile,
            1000,
            0o755,
            1,
        ),
        ClientConfigDescriptorFactsV1::new(ClientConfigDescriptorKindV1::RegularFile, 0, 0o775, 1),
        ClientConfigDescriptorFactsV1::new(ClientConfigDescriptorKindV1::Symlink, 0, 0o755, 1),
    ] {
        assert!(validate_client_executable_facts(invalid).is_err());
    }
}

#[cfg(target_os = "linux")]
#[test]
fn descriptor_walk_loads_only_exact_client_config_and_socket_path() {
    use crate::promotion_decision_client::{
        load_client_config_from_trusted_anchor_for_test,
        validate_socket_path_from_trusted_anchor_for_test,
    };
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::os::unix::net::UnixListener;

    let anchor = tempfile::tempdir().unwrap();
    fs::set_permissions(anchor.path(), fs::Permissions::from_mode(0o755)).unwrap();
    let owner = unsafe { libc::geteuid() };
    let group = unsafe { libc::getegid() };
    let protected = anchor.path().join("protected");
    fs::create_dir(&protected).unwrap();
    fs::set_permissions(&protected, fs::Permissions::from_mode(0o755)).unwrap();
    let config_path = protected.join("promotion-decision-client-v1.json");
    let public_key = SigningKey::from_bytes(&[24; 32]).verifying_key().to_bytes();
    fs::write(
        &config_path,
        serde_json::json!({
            "schema_version": 1,
            "listener_creator_uid": 0,
            "socket_group_gid": group,
            "broker_identity_public_key": public_key,
        })
        .to_string(),
    )
    .unwrap();
    fs::set_permissions(&config_path, fs::Permissions::from_mode(0o644)).unwrap();
    let loaded =
        load_client_config_from_trusted_anchor_for_test(&config_path, anchor.path(), owner)
            .unwrap();
    assert_eq!(loaded.socket_group_gid(), group);

    let replaced = protected.join("replaced.json");
    fs::write(&replaced, b"{}").unwrap();
    fs::set_permissions(&replaced, fs::Permissions::from_mode(0o644)).unwrap();
    fs::remove_file(&config_path).unwrap();
    symlink(&replaced, &config_path).unwrap();
    assert!(
        load_client_config_from_trusted_anchor_for_test(&config_path, anchor.path(), owner)
            .is_err()
    );

    let socket_path = protected.join("promotion-decision-v1.sock");
    let _listener = UnixListener::bind(&socket_path).unwrap();
    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o660)).unwrap();
    let before = validate_socket_path_from_trusted_anchor_for_test(
        &socket_path,
        anchor.path(),
        owner,
        group,
    )
    .unwrap();
    let after = validate_socket_path_from_trusted_anchor_for_test(
        &socket_path,
        anchor.path(),
        owner,
        group,
    )
    .unwrap();
    assert_eq!(before, after);
}

#[cfg(target_os = "linux")]
#[test]
fn connected_exchange_writes_one_request_and_accepts_only_a_complete_exact_response() {
    use crate::promotion_decision_client::exchange_promotion_decision_with_stream_for_test;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    use std::thread;

    let request = parse_client_request_stdin(
        br#"{"schema_version":1,"promotion_approval_request_event_id":"123e4567-e89b-12d3-a456-426614174001","decision":"promote"}"#,
    )
    .unwrap();
    let signing_key = SigningKey::from_bytes(&[31; 32]);
    let verifying_key = signing_key.verifying_key();
    let (mut client, mut server) = UnixStream::pair().unwrap();
    let response_signing_key = signing_key.clone();
    let server_thread = thread::spawn(move || {
        let mut header = [0_u8; 4];
        server.read_exact(&mut header).unwrap();
        let length = u32::from_be_bytes(header) as usize;
        let mut payload = vec![0_u8; length];
        server.read_exact(&mut payload).unwrap();
        let request_wire: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        let request_id = request_wire["request_id"].as_str().unwrap();
        let response = sign_promotion_decision_response_for_test(
            &response_signing_key,
            PromotionDecisionResponseBindingV1::new(request_id, APPROVAL_EVENT_ID, "promote")
                .unwrap(),
            PromotionDecisionResponseStatusV1::Sealed,
        )
        .unwrap();
        server
            .write_all(&(response.len() as u32).to_be_bytes())
            .unwrap();
        server.write_all(&response).unwrap();
    });
    assert_eq!(
        exchange_promotion_decision_with_stream_for_test(
            &mut client,
            unsafe { libc::geteuid() },
            &verifying_key,
            &request,
        )
        .unwrap(),
        PromotionDecisionClientStatusV1::Sealed
    );
    server_thread.join().unwrap();

    let (mut client, mut server) = UnixStream::pair().unwrap();
    let server_thread = thread::spawn(move || {
        let mut discard = [0_u8; 4096];
        let _ = server.read(&mut discard).unwrap();
        server.write_all(&4097_u32.to_be_bytes()).unwrap();
    });
    assert!(exchange_promotion_decision_with_stream_for_test(
        &mut client,
        unsafe { libc::geteuid() },
        &verifying_key,
        &request,
    )
    .is_err());
    server_thread.join().unwrap();

    let (mut client, mut server) = UnixStream::pair().unwrap();
    let response_signing_key = signing_key.clone();
    let server_thread = thread::spawn(move || {
        let mut header = [0_u8; 4];
        server.read_exact(&mut header).unwrap();
        let length = u32::from_be_bytes(header) as usize;
        let mut payload = vec![0_u8; length];
        server.read_exact(&mut payload).unwrap();
        let request_wire: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        let response = sign_promotion_decision_response_for_test(
            &response_signing_key,
            PromotionDecisionResponseBindingV1::new(
                request_wire["request_id"].as_str().unwrap(),
                APPROVAL_EVENT_ID,
                "promote",
            )
            .unwrap(),
            PromotionDecisionResponseStatusV1::Sealed,
        )
        .unwrap();
        server
            .write_all(&(response.len() as u32).to_be_bytes())
            .unwrap();
        server.write_all(&response).unwrap();
        server.write_all(b"x").unwrap();
    });
    assert!(exchange_promotion_decision_with_stream_for_test(
        &mut client,
        unsafe { libc::geteuid() },
        &verifying_key,
        &request,
    )
    .is_err());
    server_thread.join().unwrap();
}
