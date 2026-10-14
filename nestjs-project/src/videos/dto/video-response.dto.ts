import { ApiProperty } from '@nestjs/swagger';

export class UploadPartUrlDto {
  @ApiProperty({ description: '1-based part number this URL uploads.' })
  part_number: number;

  @ApiProperty({ description: 'Presigned URL the client PUTs the part to.' })
  url: string;

  @ApiProperty({ description: 'Seconds until the URL expires.' })
  expires_in: number;
}

export class VideoUploadInitResponseDto {
  @ApiProperty({ format: 'uuid', description: 'Internal video id.' })
  id: string;

  @ApiProperty({ description: 'Opaque identifier used in public URLs.' })
  public_id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ description: 'Always `draft` right after pre-registration.' })
  status: string;

  @ApiProperty({
    description: 'Multipart upload id; required to presign parts.',
  })
  upload_id: string;

  @ApiProperty({ description: 'Size of each part, in bytes.' })
  part_size: number;

  @ApiProperty({ description: 'Number of parts the declared size needs.' })
  part_count: number;

  @ApiProperty({ format: 'date-time' })
  created_at: string;
}

export class VideoPartsResponseDto {
  @ApiProperty({ type: [UploadPartUrlDto] })
  parts: UploadPartUrlDto[];
}

export class VideoCompleteResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  public_id: string;

  @ApiProperty({
    description: 'Always `processing` after a successful upload.',
  })
  status: string;
}

export class VideoPublicResponseDto {
  @ApiProperty()
  public_id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ description: 'One of draft, processing, ready, error.' })
  status: string;

  @ApiProperty({
    nullable: true,
    description: 'Duration in seconds, once the worker has probed the file.',
  })
  duration_seconds: number | null;

  @ApiProperty({
    nullable: true,
    description: 'Path to the thumbnail endpoint, once one exists.',
  })
  thumbnail_url: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at: string;
}

export class VideoPlaybackUrlResponseDto {
  @ApiProperty({ description: 'Freshly presigned playback URL.' })
  url: string;

  @ApiProperty({ description: 'Seconds until the URL expires.' })
  expires_in: number;
}
