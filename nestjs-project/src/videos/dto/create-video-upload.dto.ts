import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ALLOWED_MIME_TYPES,
  MAX_PART_SIZE_BYTES,
  MIN_PART_SIZE_BYTES,
} from '../videos.constants';

export class CreateVideoUploadDto {
  /** Title shown for the video. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  /**
   * Original file name, kept for display only — storage keys are derived from the
   * video's internal id, never from this value.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  /**
   * Declared size in bytes. The 10GB ceiling is enforced by the service rather
   * than by a `@Max` here, because exceeding it is a distinct domain outcome
   * (`413 PAYLOAD_TOO_LARGE`) and not a malformed request. The real object size is
   * verified again on completion, so under-reporting it here does not help.
   */
  @IsInt()
  @Min(1)
  size_bytes: number;

  /** Container type of the uploaded file. */
  @IsIn([...ALLOWED_MIME_TYPES])
  mime_type: string;

  /**
   * Size of each multipart part. Defaults to 8MiB. Must stay at or above S3's
   * 5MiB floor, which applies to every part except the last.
   */
  @IsOptional()
  @IsInt()
  @Min(MIN_PART_SIZE_BYTES)
  @Max(MAX_PART_SIZE_BYTES)
  part_size?: number;
}
