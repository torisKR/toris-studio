package com.toris.studio.remote

import org.json.JSONObject
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.Base64
import java.util.Locale

/** A scanned enrollment value exists only in memory and is never persisted or logged. */
internal class PairingData private constructor(
    val host: String,
    val port: Int,
    val fingerprint: String,
    val expiresAt: Long,
    private val token: ByteArray,
) {
    fun tokenForEnrollment(): String = Base64.getUrlEncoder().withoutPadding().encodeToString(token)

    fun confirmationCode(devicePublicKey: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update("toris-mobile-confirm-v1\u0000".toByteArray(Charsets.US_ASCII))
        digest.update(token)
        digest.update(devicePublicKey)
        val number = (ByteBuffer.wrap(digest.digest()).int.toLong() and 0x7fffffffL) % 1_000_000
        return String.format(Locale.ROOT, "%06d", number)
    }

    override fun toString(): String = "PairingData(redacted)"

    companion object {
        private val fields = setOf("v", "host", "port", "fingerprint", "expires", "token")

        fun parse(text: String, now: Long = System.currentTimeMillis() / 1000): PairingData {
            require(text.length <= 2048) { "QR 코드가 너무 큽니다." }
            val json = try { JSONObject(text) } catch (_: Exception) { throw IllegalArgumentException("QR 코드 형식을 확인하세요.") }
            require(json.keys().asSequence().toSet() == fields) { "지원하지 않는 QR 코드입니다." }
            require(json.opt("v") == 1) { "지원하지 않는 연결 버전입니다." }
            val host = json.opt("host") as? String ?: throw IllegalArgumentException("Mac 주소를 확인하세요.")
            require(isPrivateIpv4(host)) { "사설 네트워크의 Mac 주소가 필요합니다." }
            val port = json.opt("port") as? Int ?: throw IllegalArgumentException("연결 포트를 확인하세요.")
            require(port in 1..65535) { "연결 포트를 확인하세요." }
            val fingerprint = json.opt("fingerprint") as? String ?: throw IllegalArgumentException("Mac 지문을 확인하세요.")
            HostKeyPin.parseFingerprint(fingerprint)
            val expires = when (val value = json.opt("expires")) {
                is Int -> value.toLong()
                is Long -> value
                else -> throw IllegalArgumentException("QR 만료 시간을 확인하세요.")
            }
            require(expires > now && expires - now <= 120) { "QR이 만료되었거나 유효 시간이 잘못되었습니다. Mac에서 다시 발급하세요." }
            val encoded = json.opt("token") as? String ?: throw IllegalArgumentException("등록 정보를 확인하세요.")
            require(encoded.matches(Regex("[A-Za-z0-9_-]{43}"))) { "등록 정보를 확인하세요." }
            val token = try { Base64.getUrlDecoder().decode(encoded) } catch (_: IllegalArgumentException) { throw IllegalArgumentException("등록 정보를 확인하세요.") }
            require(token.size == 32 && Base64.getUrlEncoder().withoutPadding().encodeToString(token) == encoded) { "등록 정보를 확인하세요." }
            return PairingData(host, port, fingerprint, expires, token)
        }

        fun isPrivateIpv4(host: String): Boolean {
            val parts = host.split('.')
            if (parts.size != 4) return false
            val octets = parts.map {
                if (!it.matches(Regex("0|[1-9][0-9]{0,2}"))) return false
                it.toIntOrNull()?.takeIf { number -> number in 0..255 } ?: return false
            }
            return octets[0] == 10 || (octets[0] == 172 && octets[1] in 16..31) || (octets[0] == 192 && octets[1] == 168)
        }
    }
}
