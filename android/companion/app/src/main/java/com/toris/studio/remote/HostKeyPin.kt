package com.toris.studio.remote

import com.jcraft.jsch.HostKey
import com.jcraft.jsch.HostKeyRepository
import com.jcraft.jsch.UserInfo
import java.security.MessageDigest
import java.util.Base64

/** Never learns or replaces a host key: a changed Mac key requires a new QR. */
internal class HostKeyPin(fingerprint: String) : HostKeyRepository {
    private val expected = parseFingerprint(fingerprint)

    override fun check(host: String?, key: ByteArray): Int =
        if (MessageDigest.isEqual(expected, MessageDigest.getInstance("SHA-256").digest(key))) {
            HostKeyRepository.OK
        } else {
            HostKeyRepository.CHANGED
        }

    override fun add(hostkey: HostKey?, userInfo: UserInfo?) = throw UnsupportedOperationException("호스트 키를 자동으로 변경할 수 없습니다.")
    override fun remove(host: String?, type: String?) = Unit
    override fun remove(host: String?, type: String?, key: ByteArray?) = Unit
    override fun getKnownHostsRepositoryID(): String = "Toris Studio"
    override fun getHostKey(): Array<HostKey> = emptyArray()
    override fun getHostKey(host: String?, type: String?): Array<HostKey> = emptyArray()

    companion object {
        fun fingerprint(blob: ByteArray): String = "SHA256:" + Base64.getEncoder().withoutPadding()
            .encodeToString(MessageDigest.getInstance("SHA-256").digest(blob))

        fun parseFingerprint(value: String): ByteArray {
            require(value.startsWith("SHA256:")) { "호스트 지문을 확인하세요." }
            val encoded = value.removePrefix("SHA256:")
            require(encoded.matches(Regex("[A-Za-z0-9+/]{43}"))) { "호스트 지문을 확인하세요." }
            val decoded = Base64.getDecoder().decode(encoded)
            require(decoded.size == 32 && Base64.getEncoder().withoutPadding().encodeToString(decoded) == encoded)
            return decoded
        }
    }
}
