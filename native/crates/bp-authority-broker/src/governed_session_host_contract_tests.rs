use crate::governed_session_client::{
    parse_governed_session_client_request, GovernedSessionClientOperationV1,
};
use crate::governed_session_host::{
    handle_governed_session_connection_for_test, GovernedSessionHostDispositionV1,
};
use crate::governed_session_response::verify_governed_session_response_v1;
use ed25519_dalek::SigningKey;
use serde_json::json;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn probe_request() -> Vec<u8> {
    br#"{"schema_version":1,"protocol":"buildplane-governed-session","request_id":"01919000-0000-7000-8000-000000000090","operation":"probe"}"#.to_vec()
}

fn run_candidate_request() -> Vec<u8> {
    br#"{"schema_version":1,"protocol":"buildplane-governed-session","request_id":"01919000-0000-7000-8000-000000000091","operation":"run_candidate_session","recovery_ref":"host-recovery/session-0001","session_ref":"host-session/session-0001"}"#.to_vec()
}

fn write_request(stream: &mut UnixStream, request: &[u8]) {
    stream
        .write_all(&(request.len() as u32).to_be_bytes())
        .unwrap();
    stream.write_all(request).unwrap();
    stream.shutdown(std::net::Shutdown::Write).unwrap();
}

fn read_response(stream: &mut UnixStream) -> Vec<u8> {
    let mut length = [0_u8; 4];
    stream.read_exact(&mut length).unwrap();
    let mut response = vec![0_u8; u32::from_be_bytes(length) as usize];
    stream.read_exact(&mut response).unwrap();
    let mut trailing = [0_u8; 1];
    assert_eq!(stream.read(&mut trailing).unwrap(), 0);
    response
}

#[test]
fn authenticated_host_signs_only_the_closed_handler_disposition() {
    let signing_key = SigningKey::from_bytes(&[61; 32]);
    let verifying_key = signing_key.verifying_key();
    let request_bytes = probe_request();
    let parsed = parse_governed_session_client_request(&request_bytes).unwrap();
    let (mut client, mut server) = UnixStream::pair().unwrap();
    let thread = std::thread::spawn(move || {
        handle_governed_session_connection_for_test(
            &mut server,
            unsafe { libc::geteuid() },
            &signing_key,
            Duration::from_secs(1),
            |request| {
                assert_eq!(request.operation(), GovernedSessionClientOperationV1::Probe);
                Ok(GovernedSessionHostDispositionV1::Ready)
            },
        )
    });

    write_request(&mut client, &request_bytes);
    let response = read_response(&mut client);
    assert!(thread.join().unwrap().is_ok());
    let verified = verify_governed_session_response_v1(&response, &verifying_key, &parsed).unwrap();
    assert!(std::str::from_utf8(verified.projection_json())
        .unwrap()
        .contains(r#""status":"ready""#));
}

#[test]
fn malformed_or_trailing_requests_are_rejected_before_the_authority_handler() {
    for request in [br#"{"schema_version":1}"#.to_vec(), {
        let mut request = probe_request();
        request.extend_from_slice(b"x");
        request
    }] {
        let signing_key = SigningKey::from_bytes(&[62; 32]);
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&calls);
        let (mut client, mut server) = UnixStream::pair().unwrap();
        let thread = std::thread::spawn(move || {
            handle_governed_session_connection_for_test(
                &mut server,
                unsafe { libc::geteuid() },
                &signing_key,
                Duration::from_secs(1),
                |_| {
                    observed.fetch_add(1, Ordering::SeqCst);
                    Ok(GovernedSessionHostDispositionV1::Ready)
                },
            )
        });
        write_request(&mut client, &request);
        assert!(thread.join().unwrap().is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn handler_cannot_substitute_recovery_or_session_identity() {
    let signing_key = SigningKey::from_bytes(&[63; 32]);
    let request = run_candidate_request();
    let (mut client, mut server) = UnixStream::pair().unwrap();
    let thread = std::thread::spawn(move || {
        handle_governed_session_connection_for_test(
            &mut server,
            unsafe { libc::geteuid() },
            &signing_key,
            Duration::from_secs(1),
            |_| {
                Ok(GovernedSessionHostDispositionV1::Completed {
                    recovery_ref: "host-recovery/substituted".into(),
                    session_ref: "host-session/session-0001".into(),
                    result: json!({"kind": "host-owned-governed-candidate-run-result-v1"}),
                })
            },
        )
    });
    write_request(&mut client, &request);
    assert!(thread.join().unwrap().is_err());
    let mut byte = [0_u8; 1];
    assert_eq!(client.read(&mut byte).unwrap(), 0);
}

#[test]
fn request_reader_uses_one_absolute_deadline_for_slow_drip_frames() {
    let signing_key = SigningKey::from_bytes(&[64; 32]);
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&calls);
    let request = probe_request();
    let (mut client, mut server) = UnixStream::pair().unwrap();
    let started = Instant::now();
    let thread = std::thread::spawn(move || {
        handle_governed_session_connection_for_test(
            &mut server,
            unsafe { libc::geteuid() },
            &signing_key,
            Duration::from_millis(150),
            |_| {
                observed.fetch_add(1, Ordering::SeqCst);
                Ok(GovernedSessionHostDispositionV1::Ready)
            },
        )
    });
    let mut frame = (request.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(&request);
    for byte in frame {
        if client.write_all(&[byte]).is_err() {
            break;
        }
        std::thread::sleep(Duration::from_millis(60));
    }
    assert!(thread.join().unwrap().is_err());
    assert!(started.elapsed() < Duration::from_millis(350));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}
