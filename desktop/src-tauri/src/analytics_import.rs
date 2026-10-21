//! Bounded, inert report parsing. No workbook formula, macro, link or path execution.
use super::{Observation, MAX_BYTES, MAX_COLUMNS, MAX_ROWS};
use base64::Engine;
use calamine::{Data, Reader, Xlsx};
use chrono::{NaiveDate, Utc};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    io::Cursor,
};

pub(crate) struct Preview {
    pub headers: Vec<String>,
    pub sample: Vec<Vec<String>>,
    pub row_count: usize,
    pub observations: Vec<Observation>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}
fn err(message: &str) -> String {
    format!("보고서: {message}")
}
pub(crate) fn parse_table(input: &Value) -> Result<(Vec<String>, Vec<Vec<String>>), String> {
    let name = input["filename"]
        .as_str()
        .ok_or_else(|| err("파일 이름이 필요합니다."))?
        .to_lowercase();
    if input.get("text").is_some() == input.get("bytesBase64").is_some() {
        return Err(err("텍스트 또는 파일 바이트 중 하나만 제공하세요."));
    }
    let bytes = if let Some(text) = input["text"].as_str() {
        if text.len() > MAX_BYTES {
            return Err(err("파일은 5 MiB 이하여야 합니다."));
        }
        text.as_bytes().to_vec()
    } else {
        let encoded = input["bytesBase64"]
            .as_str()
            .ok_or_else(|| err("파일 바이트가 필요합니다."))?;
        if encoded.len() > (MAX_BYTES + 2) / 3 * 4 {
            return Err(err("파일은 5 MiB 이하여야 합니다."));
        }
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| err("Base64 형식 오류"))?
    };
    if bytes.len() > MAX_BYTES {
        return Err(err("파일은 5 MiB 이하여야 합니다."));
    }
    let table = if name.ends_with(".xlsx") {
        let mut zip =
            zip::ZipArchive::new(Cursor::new(&bytes)).map_err(|_| err("XLSX 압축 형식 오류"))?;
        if zip.len() > 2000 {
            return Err(err("XLSX 항목 수 제한 초과"));
        }
        let mut expanded = 0u64;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|_| err("XLSX 압축 항목 오류"))?;
            expanded = expanded
                .checked_add(entry.size())
                .ok_or_else(|| err("XLSX 크기 초과"))?;
            let path = entry.name().to_lowercase();
            if expanded > 30 * 1024 * 1024 || entry.size() > 20 * 1024 * 1024 {
                return Err(err("XLSX 압축 해제 크기 제한 초과"));
            }
            if path.starts_with("xl/worksheets/") && path.ends_with(".xml") {
                let mut xml = quick_xml::Reader::from_reader(std::io::BufReader::new(&mut entry));
                let mut buffer = Vec::new();
                loop {
                    match xml
                        .read_event_into(&mut buffer)
                        .map_err(|_| err("XLSX XML 오류"))?
                    {
                        quick_xml::events::Event::Start(e) | quick_xml::events::Event::Empty(e) => {
                            if e.local_name().as_ref() == b"f" {
                                return Err(err("수식 셀은 허용되지 않습니다. 값으로 내보내세요."));
                            }
                            for attribute in e.attributes() {
                                let attribute = attribute.map_err(|_| err("XLSX 셀 속성 오류"))?;
                                if attribute.key.as_ref() == b"r"
                                    || attribute.key.as_ref() == b"ref"
                                {
                                    let value = std::str::from_utf8(attribute.value.as_ref())
                                        .map_err(|_| err("XLSX 좌표 오류"))?;
                                    for coordinate in value.split(':') {
                                        let letters = coordinate
                                            .bytes()
                                            .take_while(u8::is_ascii_alphabetic)
                                            .collect::<Vec<_>>();
                                        let digits = &coordinate[letters.len()..];
                                        let mut column = 0usize;
                                        for letter in letters {
                                            column = column
                                                .checked_mul(26)
                                                .and_then(|n| {
                                                    n.checked_add(
                                                        (letter.to_ascii_uppercase() - b'A' + 1)
                                                            as usize,
                                                    )
                                                })
                                                .ok_or_else(|| err("XLSX 열 제한 초과"))?;
                                        }
                                        if column > MAX_COLUMNS
                                            || digits
                                                .parse::<usize>()
                                                .is_ok_and(|n| n > MAX_ROWS + 1)
                                        {
                                            return Err(err("XLSX 행/열 좌표 제한 초과"));
                                        }
                                    }
                                }
                            }
                        }
                        quick_xml::events::Event::Eof => break,
                        _ => {}
                    }
                    buffer.clear();
                }
            }
            if path.contains("vbaproject")
                || path.contains("externallinks/")
                || path.contains("embeddings/")
            {
                return Err(err("매크로·외부 링크·포함 개체는 허용되지 않습니다."));
            }
        }
        drop(zip);
        let mut workbook: Xlsx<_> =
            Xlsx::new(Cursor::new(bytes)).map_err(|_| err("XLSX 문서를 읽을 수 없습니다."))?;
        if workbook.sheet_names().len() != 1 {
            return Err(err("정확히 하나의 시트만 포함하세요."));
        }
        let sheet = workbook.sheet_names()[0].clone();
        let formulas = workbook
            .worksheet_formula(&sheet)
            .map_err(|_| err("수식 검증 실패"))?;
        if formulas.cells().any(|(_, _, formula)| !formula.is_empty()) {
            return Err(err("수식 셀은 허용되지 않습니다. 값으로 내보내세요."));
        }
        let range = workbook
            .worksheet_range(&sheet)
            .map_err(|_| err("시트 읽기 실패"))?;
        if range.height() > MAX_ROWS + 1 || range.width() > MAX_COLUMNS {
            return Err(err("행 또는 열 제한 초과"));
        }
        range
            .rows()
            .map(|row| {
                row.iter()
                    .map(|cell| match cell {
                        Data::Empty => String::new(),
                        Data::DateTime(value) => value
                            .as_datetime()
                            .map(|d| d.date().to_string())
                            .unwrap_or_else(|| value.to_string()),
                        _ => cell.to_string(),
                    })
                    .collect()
            })
            .collect::<Vec<Vec<String>>>()
    } else if name.ends_with(".csv") || name.ends_with(".tsv") || name.ends_with(".txt") {
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| err("UTF-8 CSV/TSV만 지원합니다."))?
            .trim_start_matches('\u{feff}');
        let delimiter = if name.ends_with(".tsv")
            || (name.ends_with(".txt") && text.lines().next().unwrap_or("").contains('\t'))
        {
            b'\t'
        } else {
            b','
        };
        let mut reader = csv::ReaderBuilder::new()
            .has_headers(false)
            .delimiter(delimiter)
            .flexible(false)
            .from_reader(text.as_bytes());
        let mut rows = Vec::new();
        for record in reader.records() {
            let record = record.map_err(|_| err("CSV 열 수 또는 따옴표 형식 오류"))?;
            if rows.len() > MAX_ROWS || record.len() > MAX_COLUMNS {
                return Err(err("행 또는 열 제한 초과"));
            }
            rows.push(record.iter().map(str::to_string).collect());
        }
        rows
    } else {
        return Err(err(
            "CSV, TSV, XLSX만 지원합니다. XLS/XLSM은 허용되지 않습니다.",
        ));
    };
    if table.len() < 2 {
        return Err(err("머리글과 최소 한 행이 필요합니다."));
    }
    if table
        .iter()
        .flatten()
        .any(|v| v.len() > 4096 || v.contains('\0'))
    {
        return Err(err("셀 크기 또는 제어 문자 제한 초과"));
    }
    let mut rows = table;
    let headers = rows
        .remove(0)
        .into_iter()
        .map(|s| s.trim().to_string())
        .collect::<Vec<_>>();
    if headers.is_empty()
        || headers.iter().any(String::is_empty)
        || headers.iter().collect::<HashSet<_>>().len() != headers.len()
    {
        return Err(err("머리글은 비어 있지 않고 중복되지 않아야 합니다."));
    }
    if rows.iter().any(|row| row.len() != headers.len()) {
        return Err(err("행마다 열 수가 같아야 합니다."));
    }
    Ok((headers, rows))
}
fn cell<'a>(row: &'a [String], headers: &[String], column: &str) -> Result<&'a str, String> {
    let index = headers
        .iter()
        .position(|name| name == column)
        .ok_or_else(|| err(&format!("열을 찾을 수 없습니다: {column}")))?;
    Ok(row[index].trim())
}
fn date(raw: &str) -> Result<String, String> {
    let day = NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .map_err(|_| err("날짜는 YYYY-MM-DD 형식이어야 합니다."))?;
    if day.to_string() != raw {
        return Err(err("날짜 형식 오류"));
    }
    Ok(raw.to_string())
}
pub(crate) fn preview(input: &Value) -> Result<Preview, String> {
    let (headers, rows) = parse_table(input)?;
    let mut result = Preview {
        headers: headers.clone(),
        sample: rows.iter().take(8).cloned().collect(),
        row_count: rows.len(),
        observations: vec![],
        errors: vec![],
        warnings: vec![],
    };
    let Some(mapping) = input["mapping"].as_object() else {
        result
            .warnings
            .push("지표·값·날짜 열과 시간대를 매핑한 뒤 미리보기를 다시 실행하세요.".into());
        return Ok(result);
    };
    let platform = super::platform(input)?;
    let account = super::required(input, "accountId", 256)?;
    let timezone = super::required(input, "timezone", 128)?;
    timezone
        .parse::<chrono_tz::Tz>()
        .map_err(|_| err("IANA 시간대를 선택하세요."))?;
    let aggregation = super::required(input, "aggregation", 16)?;
    if !["period", "cumulative", "snapshot"].contains(&aggregation.as_str()) {
        return Err(err("기간/누적/관측 유형을 선택하세요."));
    }
    let wide = mapping.get("metrics").and_then(Value::as_object);
    let long = mapping
        .get("metric")
        .and_then(Value::as_str)
        .zip(mapping.get("value").and_then(Value::as_str));
    if wide.is_some() == long.is_some() || wide.is_some_and(|m| m.is_empty() || m.len() > 40) {
        return Err(err("지표+값 열 또는 지표 열 목록 중 하나를 매핑하세요."));
    }
    let mut keys = HashSet::new();
    for (index, row) in rows.iter().enumerate() {
        let parsed = (|| -> Result<Vec<Observation>, String> {
            let start = date(
                if let Some(column) = mapping.get("date").and_then(Value::as_str) {
                    cell(row, &headers, column)?
                } else {
                    input["periodStart"]
                        .as_str()
                        .ok_or_else(|| err("기간 시작일 필요"))?
                },
            )?;
            let end = date(
                if let Some(column) = mapping.get("endDate").and_then(Value::as_str) {
                    cell(row, &headers, column)?
                } else {
                    input["periodEnd"].as_str().unwrap_or(&start)
                },
            )?;
            if start > end {
                return Err(err("기간 시작일이 종료일보다 늦습니다."));
            }
            let content_id = mapping
                .get("contentId")
                .and_then(Value::as_str)
                .map(|col| cell(row, &headers, col))
                .transpose()?
                .unwrap_or("")
                .to_string();
            let mut dimensions = BTreeMap::new();
            if let Some(cols) = mapping.get("dimensions").and_then(Value::as_object) {
                if cols.len() > 10 {
                    return Err(err("차원은 최대 10개입니다."));
                }
                for (key, col) in cols {
                    dimensions.insert(
                        key.clone(),
                        cell(
                            row,
                            &headers,
                            col.as_str().ok_or_else(|| err("차원 매핑 오류"))?,
                        )?
                        .to_string(),
                    );
                }
            }
            let metric_values: Vec<(String, String, String)> = if let Some(cols) = wide {
                cols.iter()
                    .map(|(col, metric)| {
                        Ok((
                            metric.as_str().ok_or_else(|| err("지표 매핑 오류"))?.into(),
                            cell(row, &headers, col)?.into(),
                            col.clone(),
                        ))
                    })
                    .collect::<Result<_, String>>()?
            } else {
                let (metric, value) = long.unwrap();
                vec![(
                    cell(row, &headers, metric)?.into(),
                    cell(row, &headers, value)?.into(),
                    value.into(),
                )]
            };
            metric_values.into_iter().map(|(metric,raw,column)| {
                if metric.is_empty() || metric.len()>128 || super::excluded_metric(&metric) { return Err(err("지표 이름이 비어 있거나 허용 범위 밖입니다. 수익·광고 지표는 지원하지 않습니다.")); }
                let value = if raw.is_empty() || ["—","-","N/A","null"].contains(&raw.as_str()) {None} else {
                    let value: f64 = raw.parse().map_err(|_|err("숫자는 구분 기호·수식 없이 입력하세요."))?;
                    if !value.is_finite() {return Err(err("유한한 숫자만 허용됩니다."));} Some(value)
                };
                let def = &input["definitions"][&metric];
                let definition = def["definition"].as_str().unwrap_or("");
                if definition.len()>4096||def["unit"].as_str().is_some_and(|unit|unit.len()>64){return Err(err("지표 정의 또는 단위 길이 제한 초과"));}
                let key = json!([metric,start,end,content_id,dimensions]).to_string();
                if !keys.insert(key) {return Err(err("같은 지표·기간·콘텐츠·차원이 중복되었습니다."));}
                Ok(Observation {platform:platform.clone(),account_id:account.clone(),connection_id:None,source_kind:"import".into(),metric:metric.clone(),definition:if definition.is_empty(){format!("사용자 보고서 열: {column}; API 지표와 동등하다고 확인되지 않음")}else{definition.into()},unit:def["unit"].as_str().unwrap_or("report_unit").into(),aggregation:aggregation.clone(),period_start:start.clone(),period_end:end.clone(),timezone:timezone.clone(),content_id:content_id.clone(),dimensions:json!(dimensions),value,status:if value.is_some(){"available"}else{"not_returned"}.into(),observed_at:Utc::now().to_rfc3339(),api_version:"manual-report-v1".into(),provenance:json!({"column":column,"row":index+2,"definitionSupplied":!definition.is_empty(),"definitionAuthority":"user_report","apiEquivalenceVerified":false,"originalValue":raw})})
            }).collect()
        })();
        match parsed {
            Ok(items) => {
                result.observations.extend(items);
                if result.observations.len() > 20_000 {
                    return Err(err(
                        "최대 20,000개 관측만 가져올 수 있습니다. 파일 범위를 줄이세요.",
                    ));
                }
            }
            Err(message) => {
                result.errors.push(format!("{}행: {message}", index + 2));
                if result.errors.len() >= 50 {
                    break;
                }
            }
        }
    }
    if result.observations.len() > 20_000 {
        return Err(err("지표 관측 수 제한 초과"));
    }
    result.warnings.push("수동 보고서는 API 값과 별도 출처로 저장됩니다. 누적 관측에서 일별 실적을 계산하지 않습니다.".into());
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(text: &str) -> Value {
        json!({"filename":"a.csv","text":text,"platform":"x","accountId":"me","timezone":"Asia/Seoul","aggregation":"period","mapping":{"date":"date","metrics":{"views":"views"}}})
    }
    #[test]
    fn zero_and_missing_remain_distinct() {
        let p = preview(&input("date,views\n2026-10-01,0\n2026-10-02,\n")).unwrap();
        assert!(p.errors.is_empty());
        assert_eq!(p.observations[0].value, Some(0.));
        assert_eq!(p.observations[1].value, None);
        assert_eq!(p.observations[1].status, "not_returned");
    }
    #[test]
    fn rejects_duplicate_overlap_and_unknown_timezone() {
        assert!(!preview(&input("date,views\n2026-10-01,1\n2026-10-01,2"))
            .unwrap()
            .errors
            .is_empty());
        let mut i = input("date,views\n2026-10-01,1");
        i["timezone"] = json!("Seoul");
        assert!(preview(&i).is_err());
    }
    #[test]
    fn requires_mapping_before_commit() {
        let mut i = input("date,views\n2026-10-01,1");
        i.as_object_mut().unwrap().remove("mapping");
        let p = preview(&i).unwrap();
        assert!(p.observations.is_empty());
        assert_eq!(p.headers, ["date", "views"]);
    }
    #[test]
    fn rejects_formula_numbers_and_malformed_dates() {
        assert!(!preview(&input("date,views\n2026-10-01,=1+2"))
            .unwrap()
            .errors
            .is_empty());
        assert!(!preview(&input("date,views\n2026-13-01,2"))
            .unwrap()
            .errors
            .is_empty());
    }
    #[test]
    fn csv_quotes_and_tsv_are_inert() {
        let mut i = input("date,views\n2026-10-01,\"12\"");
        assert_eq!(preview(&i).unwrap().observations[0].value, Some(12.));
        i["filename"] = json!("a.tsv");
        i["text"] = json!("date\tviews\n2026-10-01\t2");
        assert_eq!(preview(&i).unwrap().observations[0].value, Some(2.));
    }
    #[test]
    fn rejects_mixed_bytes_and_text_or_active_workbook_extension() {
        let mut i = input("date,views\n2026-10-01,1");
        i["bytesBase64"] = json!("AA==");
        assert!(parse_table(&i).is_err());
        i.as_object_mut().unwrap().remove("bytesBase64");
        i["filename"] = json!("a.xlsm");
        assert!(parse_table(&i).is_err());
    }
}

#[cfg(test)]
mod workbook_tests {
    use super::*;
    use std::io::Write;
    fn workbook(sheet: &str, extra: Option<(&str, &str)>) -> Value {
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let entries = [
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
            ),
            ("xl/worksheets/sheet1.xml", sheet),
        ];
        for (name, content) in entries.into_iter().chain(extra) {
            archive
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            archive.write_all(content.as_bytes()).unwrap();
        }
        let bytes = archive.finish().unwrap().into_inner();
        json!({"filename":"safe.xlsx","bytesBase64":base64::engine::general_purpose::STANDARD.encode(bytes)})
    }
    #[test]
    fn parses_inert_xlsx_values() {
        let input = workbook(
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>date</t></is></c><c r="B1" t="inlineStr"><is><t>views</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>2026-10-01</t></is></c><c r="B2"><v>0</v></c></row></sheetData></worksheet>"#,
            None,
        );
        let (headers, rows) = parse_table(&input).unwrap();
        assert_eq!(headers, ["date", "views"]);
        assert_eq!(rows[0], ["2026-10-01", "0"]);
    }
    #[test]
    fn rejects_workbook_formula_before_reading_cached_value() {
        let input = workbook(
            r#"<worksheet><dimension ref="A1:B2"/><sheetData><row r="2"><c r="B2"><f>HYPERLINK("https://example.invalid")</f><v>0</v></c></row></sheetData></worksheet>"#,
            None,
        );
        assert!(parse_table(&input).unwrap_err().contains("수식"));
    }
    #[test]
    fn rejects_sparse_allocation_attack() {
        let input = workbook(
            r#"<worksheet><dimension ref="A1:XFD1048576"/><sheetData><row r="1048576"><c r="XFD1048576"><v>1</v></c></row></sheetData></worksheet>"#,
            None,
        );
        assert!(parse_table(&input).unwrap_err().contains("좌표"));
    }
    #[test]
    fn rejects_embedded_macro_or_external_link() {
        for name in ["xl/vbaProject.bin", "xl/externalLinks/externalLink1.xml"] {
            let input = workbook("<worksheet/>", Some((name, "inert fixture")));
            assert!(parse_table(&input).unwrap_err().contains("매크로"));
        }
    }
}
