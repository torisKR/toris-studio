use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn oauth_connections(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    with_bindings(
        crate::oauth::connections().await?,
        &state.config_snapshot().await,
    )
    .await
}
#[tauri::command]
pub async fn oauth_connection_dispatch(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, Arc<crate::AppState>>,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    if input["action"] == "bindChannel" {
        let channel = uuid::Uuid::parse_str(
            input["channelId"]
                .as_str()
                .ok_or("채널 식별자를 선택하세요.")?,
        )
        .map_err(|_| "채널 식별자 오류")?;
        let id = input["connectionId"].as_str().ok_or("연결을 선택하세요.")?;
        let connection = uuid::Uuid::parse_str(id).map_err(|_| "연결 식별자 오류")?;
        let account = input["accountId"].as_str().ok_or("계정을 선택하세요.")?;
        let connections = crate::oauth::connections().await?;
        let selected = connections["connections"]
            .as_array()
            .and_then(|items| {
                items.iter().find(|c| {
                    c["connectionId"] == id
                        && c["accountId"] == account
                        && c["identityVerified"] == true
                        && c["disconnected"] == false
                })
            })
            .ok_or("검증된 계정 연결을 선택하세요.")?;
        let platform = selected["platform"].as_str().ok_or("플랫폼 오류")?;
        let db = crate::social::database(&state.config_snapshot().await).await?;
        let count=db.client.execute("INSERT INTO social_channel_connections(channel_id,connection_id,platform,account_id) SELECT id,$2,platform,$4 FROM social_channels WHERE id=$1 AND platform=$3 ON CONFLICT(channel_id) DO UPDATE SET connection_id=EXCLUDED.connection_id,platform=EXCLUDED.platform,account_id=EXCLUDED.account_id,verified_at=now()",&[&channel,&connection,&platform,&account]).await.map_err(|_|"채널 연결을 저장하지 못했습니다. OAuth DB 마이그레이션을 확인하세요.")?;
        if count != 1 {
            return Err("채널과 계정 플랫폼이 일치하지 않습니다.".into());
        }
        let binding = json!({"channelId":channel,"connectionId":id,"platform":platform,"accountId":account,"identityVerified":true});
        let mut result = with_bindings(
            crate::oauth::connections().await?,
            &state.config_snapshot().await,
        )
        .await?;
        result["binding"] = binding;
        return Ok(result);
    }
    let begin = input["action"] == "beginLogin";
    let disconnect = if input["action"] == "disconnect" { input["connectionId"].as_str().map(str::to_owned) } else { None };
    let mut result = crate::oauth::connection_dispatch(input).await?;
    if let Some(id) = disconnect {
        if cleanup_connection(&state.config_snapshot().await, &id).await.is_err() {
            if !result["warnings"].is_array() { result["warnings"]=json!([]); }
            result["warnings"].as_array_mut().unwrap().push(json!({"kind":"disconnect_cleanup","message":"연결은 해제되었습니다. 로컬 DB 복구 후 해당 예약과 API 캐시 정리를 계속합니다."}));
        }
    }
    if begin {
        use tauri_plugin_opener::OpenerExt;
        let id = result["connectionId"].clone();
        let opened = crate::oauth::finish_system_login(result, |url| {
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|_| "시스템 기본 브라우저를 열지 못했습니다.".into())
        });
        if opened.is_err() {
            let _ = crate::oauth::connection_dispatch(
                json!({"action":"cancelLogin","connectionId":id}),
            )
            .await;
        }
        opened
    } else {
        with_bindings(result, &state.config_snapshot().await).await
    }
}

pub(crate) async fn cleanup_connection(config:&crate::config::AppConfig,id:&str)->Result<(),String>{
    uuid::Uuid::parse_str(id).map_err(|_|"연결 식별자 오류")?;
    {
        let session=crate::social::database(config).await?;
        if session.client.query_one("SELECT to_regclass('public.publication_jobs')::text",&[]).await.map_err(|_|"게시 저장소 확인 실패")?.get::<_,Option<String>>(0).is_some(){
            session.client.execute("UPDATE publication_jobs SET status='needs_confirmation',retryable=false,error='계정 연결이 해제되었습니다. 다시 연결하고 승인하세요.',updated_at=now() WHERE id IN (SELECT id FROM publication_jobs WHERE snapshot->>'connectionId'=$1 AND mode<>'manual_handoff' AND status IN ('queued','scheduled','failed') FOR UPDATE SKIP LOCKED)",&[&id]).await.map_err(|_|"해제한 계정의 예약 정리 실패")?;
        }
        if session.client.query_one("SELECT to_regclass('public.analytics_sources')::text",&[]).await.map_err(|_|"분석 저장소 확인 실패")?.get::<_,Option<String>>(0).is_none(){return Ok(());}
    }
    crate::analytics::dispatch(config,json!({"action":"deleteApiCache","connectionId":id})).await?;
    Ok(())
}

// Disconnected identities remain in the secure connection index. It is the
// durable retry marker when PostgreSQL was unavailable during disconnect.
pub(crate) async fn cleanup_disconnected(config:&crate::config::AppConfig){
    if let Ok(connections)=crate::oauth::connections().await {
        let ids:std::collections::BTreeSet<&str>=connections["connections"].as_array().into_iter().flatten().filter(|c|c["disconnected"]==true).filter_map(|c|c["connectionId"].as_str()).collect();
        for id in ids { let _=cleanup_connection(config,id).await; }
    }
}

async fn with_bindings(
    mut result: Value,
    config: &crate::config::AppConfig,
) -> Result<Value, String> {
    result["bindings"] = json!([]);
    let load=async {
  let db=crate::social::database(config).await?;
  let rows=db.client.query("SELECT channel_id,connection_id,platform,account_id FROM social_channel_connections ORDER BY channel_id",&[]).await.map_err(|_|"채널 계정 매핑을 읽지 못했습니다. OAuth DB 마이그레이션을 확인하세요.".to_string())?;
  Ok::<Vec<Value>,String>(rows.iter().map(|r|json!({"channelId":r.get::<_,uuid::Uuid>("channel_id"),"connectionId":r.get::<_,uuid::Uuid>("connection_id"),"platform":r.get::<_,String>("platform"),"accountId":r.get::<_,String>("account_id")})).collect())
 }.await;
    match load {
        Ok(bindings) => result["bindings"] = json!(bindings),
        Err(message) => {
            if !result["warnings"].is_array() {
                result["warnings"] = json!([]);
            }
            result["warnings"]
                .as_array_mut()
                .unwrap()
                .push(json!({"kind":"channel_bindings","message":message}));
        }
    }
    Ok(result)
}
