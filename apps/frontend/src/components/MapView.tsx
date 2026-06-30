'use client';

import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { useMemo } from 'react';
import {
  ImageOverlay,
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  useMapEvents,
} from 'react-leaflet';
import {
  STATUS_LABELS,
  effectiveStatus,
  type Device,
  type DeviceWifiLink,
  type PatchDevicePositionInput,
  type Site,
} from '@noc/shared';
import { markerHtml } from '@/lib/icons';
import { rssiQuality } from '@/lib/wifi';

interface MapViewProps {
  site: Site;
  devices: Device[];
  wifiLinks?: Record<string, DeviceWifiLink>;
  editable: boolean;
  onSelect: (device: Device) => void;
  onMove: (id: string, pos: PatchDevicePositionInput) => void;
  onMapAdd?: (pos: PatchDevicePositionInput) => void;
}

function fpHeight(site: Site) {
  return site.floorplanHeight ?? 1000;
}
function fpWidth(site: Site) {
  return site.floorplanWidth ?? 1600;
}

function toLatLng(d: Device, site: Site): [number, number] {
  if (site.mapMode === 'geo') {
    return [d.geoLat ?? site.geoCenterLat ?? 0, d.geoLng ?? site.geoCenterLng ?? 0];
  }
  return [d.mapY ?? fpHeight(site) / 2, d.mapX ?? fpWidth(site) / 2];
}

function fromLatLng(ll: L.LatLng, site: Site): PatchDevicePositionInput {
  if (site.mapMode === 'geo') return { geoLat: ll.lat, geoLng: ll.lng };
  return { mapX: ll.lng, mapY: ll.lat };
}

function ClickToAdd({
  site,
  onMapAdd,
}: {
  site: Site;
  onMapAdd: (pos: PatchDevicePositionInput) => void;
}) {
  useMapEvents({
    click(e) {
      onMapAdd(fromLatLng(e.latlng, site));
    },
  });
  return null;
}

function DeviceMarker({
  device,
  site,
  wifi,
  editable,
  onSelect,
  onMove,
}: {
  device: Device;
  site: Site;
  wifi?: DeviceWifiLink | null;
  editable: boolean;
  onSelect: (d: Device) => void;
  onMove: (id: string, pos: PatchDevicePositionInput) => void;
}) {
  const status = effectiveStatus(device.status, device.manualOverride);
  const position = toLatLng(device, site);
  const wifiColor = wifi ? rssiQuality(wifi.rssi).color : null;
  const icon = useMemo(
    () =>
      L.divIcon({
        html: markerHtml({
          type: device.type,
          iconKey: device.iconKey,
          iconUrl: device.iconUrl,
          status,
          name: device.name,
          critical: device.isCritical,
          wifiColor,
        }),
        className: '',
        iconSize: [140, 50],
        iconAnchor: [70, 16],
        popupAnchor: [0, -18],
      }),
    [device.type, device.iconKey, device.iconUrl, device.name, device.isCritical, status, wifiColor],
  );

  return (
    <Marker
      // remount when toggling edit so draggability updates cleanly
      key={`${device.id}-${editable}`}
      position={position}
      icon={icon}
      draggable={editable}
      eventHandlers={{
        click: () => onSelect(device),
        dragend: (e) => {
          const ll = (e.target as L.Marker).getLatLng();
          onMove(device.id, fromLatLng(ll, site));
        },
      }}
    >
      <Popup>
        <div style={{ minWidth: 180 }}>
          <strong>{device.name}</strong>
          <div>Status: {STATUS_LABELS[status]}</div>
          {device.ipAddress && <div>IP: {device.ipAddress}</div>}
          <div>Type: {device.type}</div>
          {device.statusSince && (
            <div>Since: {new Date(device.statusSince).toLocaleString()}</div>
          )}
          {wifi && (
            <div>
              WiFi: {wifi.apName ?? '—'}
              {wifi.ssid ? ` (${wifi.ssid})` : ''}
              {wifi.rssi != null ? ` · ${wifi.rssi} dBm` : ''}
            </div>
          )}
          {device.isCritical && <div>⚠ critical device</div>}
        </div>
      </Popup>
    </Marker>
  );
}

export default function MapView({
  site,
  devices,
  wifiLinks,
  editable,
  onSelect,
  onMove,
  onMapAdd,
}: MapViewProps) {
  const markers = devices.map((d) => (
    <DeviceMarker
      key={d.id}
      device={d}
      site={site}
      wifi={wifiLinks?.[d.id] ?? null}
      editable={editable}
      onSelect={onSelect}
      onMove={onMove}
    />
  ));

  if (site.mapMode === 'geo') {
    const center: [number, number] = [site.geoCenterLat ?? 0, site.geoCenterLng ?? 0];
    return (
      <MapContainer
        key={`${site.id}-geo`}
        center={center}
        zoom={site.defaultZoom}
        scrollWheelZoom
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; OpenStreetMap contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {markers}
        {editable && onMapAdd && <ClickToAdd site={site} onMapAdd={onMapAdd} />}
      </MapContainer>
    );
  }

  const bounds: L.LatLngBoundsExpression =
    (site.imageBounds as L.LatLngBoundsExpression | null) ?? [
      [0, 0],
      [fpHeight(site), fpWidth(site)],
    ];

  return (
    <MapContainer
      key={`${site.id}-fp`}
      crs={L.CRS.Simple}
      bounds={bounds}
      minZoom={-3}
      maxZoom={4}
      style={{ height: '100%', width: '100%' }}
    >
      {site.floorplanImageUrl && <ImageOverlay url={site.floorplanImageUrl} bounds={bounds} />}
      {markers}
      {editable && onMapAdd && <ClickToAdd site={site} onMapAdd={onMapAdd} />}
    </MapContainer>
  );
}
