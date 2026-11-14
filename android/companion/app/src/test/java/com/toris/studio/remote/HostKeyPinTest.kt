package com.toris.studio.remote

import com.jcraft.jsch.HostKeyRepository
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class HostKeyPinTest {
    @Test fun acceptsOnlyThePinnedHostKey() {
        val original = byteArrayOf(1, 2, 3, 4)
        val pin = HostKeyPin(HostKeyPin.fingerprint(original))
        assertEquals(HostKeyRepository.OK, pin.check("mac", original))
        assertEquals(HostKeyRepository.CHANGED, pin.check("mac", byteArrayOf(4, 3, 2, 1)))
        assertThrows(UnsupportedOperationException::class.java) { pin.add(null, null) }
    }

    @Test fun refusesMalformedOrNonCanonicalFingerprints() {
        listOf("SHA256:", "MD5:123", "SHA256:" + "a".repeat(44), "SHA256:" + "/".repeat(43)).forEach {
            assertThrows(IllegalArgumentException::class.java) { HostKeyPin(it) }
        }
    }
}
