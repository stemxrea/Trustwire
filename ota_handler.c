#include <stdio.h>
#include <string.h>

#include "esp_app_format.h"
#include "esp_efuse.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_ota_ops.h"

#ifndef ESP_IMAGE_HEADER_MAGIC
#define ESP_IMAGE_HEADER_MAGIC 0xE9
#endif

#ifndef ESP_CHIP_ID_ESP32C3
#define ESP_CHIP_ID_ESP32C3 0x0005
#endif

#ifndef MIN
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#endif

#define OTA_RX_BUFFER_SIZE 1024
#define OTA_HEADER_PROBE_SIZE 1024

static const char *TAG = "ota_handler";

static esp_err_t send_forbidden(httpd_req_t *req, const char *reason)
{
    httpd_resp_set_status(req, "403 Forbidden");
    httpd_resp_set_type(req, "text/plain");
    return httpd_resp_sendstr(req, reason);
}

static esp_err_t validate_image_profile(const uint8_t *probe, size_t probe_len, char *reason, size_t reason_len)
{
    const size_t app_desc_offset = sizeof(esp_image_header_t) + sizeof(esp_image_segment_header_t);
    const size_t minimum_required = app_desc_offset + sizeof(esp_app_desc_t);

    if (probe_len < minimum_required) {
        snprintf(reason, reason_len, "Firmware header too small for structural verification.");
        return ESP_ERR_INVALID_SIZE;
    }

    const esp_image_header_t *image_header = (const esp_image_header_t *)probe;
    if (image_header->magic != ESP_IMAGE_HEADER_MAGIC) {
        snprintf(reason, reason_len, "Invalid firmware magic byte (0x%02X).", image_header->magic);
        return ESP_ERR_INVALID_ARG;
    }

    if (image_header->segment_count == 0) {
        snprintf(reason, reason_len, "Invalid image segment count.");
        return ESP_ERR_INVALID_ARG;
    }

    if ((uint16_t)image_header->chip_id != (uint16_t)ESP_CHIP_ID_ESP32C3) {
        snprintf(
            reason,
            reason_len,
            "Target chip mismatch (expected 0x%04X, got 0x%04X).",
            ESP_CHIP_ID_ESP32C3,
            (uint16_t)image_header->chip_id);
        return ESP_ERR_INVALID_ARG;
    }

    const esp_app_desc_t *app_desc = (const esp_app_desc_t *)(probe + app_desc_offset);
    ESP_LOGI(TAG, "Incoming firmware version: %s", app_desc->version);
    ESP_LOGI(TAG, "Incoming secure version: %u", app_desc->secure_version);

#if defined(CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK) && CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK
    if (!esp_efuse_check_secure_version(app_desc->secure_version)) {
        snprintf(reason, reason_len, "Rejected by anti-rollback secure version policy.");
        return ESP_ERR_INVALID_VERSION;
    }
#endif

    return ESP_OK;
}

esp_err_t ota_post_handler(httpd_req_t *req)
{
    esp_err_t err;
    esp_ota_handle_t ota_handle = 0;
    bool ota_begun = false;
    bool header_validated = false;

    const esp_partition_t *update_partition = esp_ota_get_next_update_partition(NULL);
    if (update_partition == NULL) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "No OTA update partition available.");
        return ESP_FAIL;
    }

    uint8_t rx_buffer[OTA_RX_BUFFER_SIZE];
    uint8_t header_probe[OTA_HEADER_PROBE_SIZE];
    size_t header_probe_len = 0;
    int remaining = req->content_len;

    while (remaining > 0) {
        const int recv_len = httpd_req_recv(req, (char *)rx_buffer, MIN((int)sizeof(rx_buffer), remaining));
        if (recv_len <= 0) {
            if (ota_begun) {
                esp_ota_abort(ota_handle);
            }
            if (recv_len == HTTPD_SOCK_ERR_TIMEOUT) {
                continue;
            }
            httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Firmware body receive failed.");
            return ESP_FAIL;
        }

        size_t data_offset = 0;

        // Upfront validation gate: collect and verify the first 1024 bytes before mass writes.
        if (!header_validated) {
            const size_t needed = OTA_HEADER_PROBE_SIZE - header_probe_len;
            const size_t to_copy = MIN((size_t)recv_len, needed);
            memcpy(header_probe + header_probe_len, rx_buffer, to_copy);
            header_probe_len += to_copy;
            data_offset = to_copy;

            if (header_probe_len == OTA_HEADER_PROBE_SIZE) {
                char reject_reason[160] = {0};
                err = validate_image_profile(header_probe, header_probe_len, reject_reason, sizeof(reject_reason));
                if (err != ESP_OK) {
                    ESP_LOGE(TAG, "OTA header validation failed: %s", reject_reason);
                    if (ota_begun) {
                        esp_ota_abort(ota_handle);
                    }
                    send_forbidden(req, reject_reason);
                    return ESP_FAIL;
                }

                err = esp_ota_begin(update_partition, OTA_SIZE_UNKNOWN, &ota_handle);
                if (err != ESP_OK) {
                    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "esp_ota_begin failed.");
                    return ESP_FAIL;
                }

                ota_begun = true;
                header_validated = true;

                err = esp_ota_write(ota_handle, header_probe, header_probe_len);
                if (err != ESP_OK) {
                    esp_ota_abort(ota_handle);
                    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "esp_ota_write failed (header). ");
                    return ESP_FAIL;
                }
            }
        }

        // Write remainder of current packet only after validation passed.
        if (header_validated && data_offset < (size_t)recv_len) {
            err = esp_ota_write(ota_handle, rx_buffer + data_offset, recv_len - data_offset);
            if (err != ESP_OK) {
                esp_ota_abort(ota_handle);
                httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "esp_ota_write failed.");
                return ESP_FAIL;
            }
        }

        remaining -= recv_len;
    }

    if (!header_validated) {
        char reject_reason[160] = {0};
        err = validate_image_profile(header_probe, header_probe_len, reject_reason, sizeof(reject_reason));
        if (err != ESP_OK) {
            if (ota_begun) {
                esp_ota_abort(ota_handle);
            }
            send_forbidden(req, reject_reason);
            return ESP_FAIL;
        }

        err = esp_ota_begin(update_partition, OTA_SIZE_UNKNOWN, &ota_handle);
        if (err != ESP_OK) {
            httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "esp_ota_begin failed.");
            return ESP_FAIL;
        }
        ota_begun = true;

        err = esp_ota_write(ota_handle, header_probe, header_probe_len);
        if (err != ESP_OK) {
            esp_ota_abort(ota_handle);
            httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "esp_ota_write failed (small payload). ");
            return ESP_FAIL;
        }
    }

    err = esp_ota_end(ota_handle);
    if (err != ESP_OK) {
        esp_ota_abort(ota_handle);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "esp_ota_end failed.");
        return ESP_FAIL;
    }

    err = esp_ota_set_boot_partition(update_partition);
    if (err != ESP_OK) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "esp_ota_set_boot_partition failed.");
        return ESP_FAIL;
    }

    httpd_resp_set_status(req, "200 OK");
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"status\":\"ok\",\"message\":\"firmware accepted\"}");
    return ESP_OK;
}
