package com.toris.studio.remote

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

class PairingDataTest {
    private fun valid(): JSONObject = JSONObject().apply {
        put("v", 1)
        put("host", "192.168.1.10")
        put("port", 2244)
        put("fingerprint", HostKeyPin.fingerprint(byteArrayOf(1, 2, 3)))
        put("expires", 1120)
        put("token", Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { it.toByte() }))
    }

    @Test fun acceptsOnlyFreshPrivateVersionOneCodesAndHidesTheToken() {
        val pairing = PairingData.parse(valid().toString(), 1000)
        assertEquals("192.168.1.10", pairing.host)
        assertEquals(2244, pairing.port)
        assertFalse(pairing.toString().contains(pairing.tokenForEnrollment()))
        assertEquals(pairing.confirmationCode(byteArrayOf(1, 2)), pairing.confirmationCode(byteArrayOf(1, 2)))
        assertEquals("396241", pairing.confirmationCode(byteArrayOf(1, 2)))
        assertNotEquals(pairing.confirmationCode(byteArrayOf(1, 2)), pairing.confirmationCode(byteArrayOf(1, 3)))
    }

    @Test fun rejectsExpiredUnknownVersionsAndUnsafeAddresses() {
        val invalid = listOf(
            valid().put("v", 2), valid().put("expires", 1000), valid().put("expires", 1121), valid().put("expires", 1100.5),
            valid().put("host", "8.8.8.8"), valid().put("host", "localhost"), valid().put("host", "192.168.01.1"),
            valid().put("port", 0), valid().put("token", "short"), valid().put("extra", true),
        )
        invalid.forEach { assertThrows(IllegalArgumentException::class.java) { PairingData.parse(it.toString(), 1000) } }
    }
}
